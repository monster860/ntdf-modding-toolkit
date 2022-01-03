import assert from "assert";
import { diff, intersection, MultiPolygon } from "martinez-polygon-clipping";
import { PNG } from "pngjs";
import { CollisionBoundary, CollisionChunk, FloorMaterial, FloorType } from "../chunks/collision.js";
import { ImageChunk } from "../chunks/image.js";
import { MaterialsChunk, ShaderType } from "../chunks/materials.js";
import { ModelChunk, ModelNode, ModelNodeMesh, ModelNodeType } from "../chunks/model.js";
import { GsAlphaParam, GsColorParam, GsFilter, GsStorageFormat, GsWrapMode } from "../ps2/gs_constants.js";
import { VifCodeType } from "../ps2/vifcode.js";
import { apply_matrix, distance_xz_sq, matrix_inverse, matrix_transpose, srgb_to_linear, Vec3 } from "../utils/misc.js";
import { GlTf, Material, Mesh, MeshPrimitive, Node, Scene } from "./gltf.js";
import earcut from "earcut";

export function export_gltf(materials : MaterialsChunk, images : ImageChunk[], parts : GlTfExportParts) {
	let exporter = new GlTfExporter(materials, images);
	if(parts.model) exporter.add_model(parts.model);
	if(parts.collision) exporter.add_collision(parts.collision);
	return exporter.finalize();
}

interface GlTfExportParts {
	model? : ModelChunk;
	collision? : CollisionChunk;
}

class GlTfExporter {
	gltf : GlTf;
	constructor(materials : MaterialsChunk, images : ImageChunk[]) {
		let gltf : GlTf = this.gltf = {
			asset: {
				version: "2.0",
				generator: "N:TDF Modding Toolkit"
			}
		};
		this.nodes = gltf.nodes = [];
		this.glb_materials = gltf.materials = [];
		this.meshes = gltf.meshes = [];
		gltf.samplers = [];
		gltf.textures = [];
		this.materials = materials;

		let pngs_included = new Map<string, number>();

		for(let i = 0; i < materials.materials.length; i++) {
			let material = materials.materials[i];
			let enc : Material = {
				name: "mat_" + i,
				doubleSided: true,
				extras: {
					ntdf_mat_index: i
				}
			};
			// Enable alpha blending for our basic blending equation
			if(material.passes[0].alpha_blend_a == GsColorParam.RgbSource
				&& material.passes[0].alpha_blend_b == GsColorParam.RgbDest
				&& material.passes[0].alpha_blend_c == GsAlphaParam.AlphaSource
				&& material.passes[0].alpha_blend_d == GsColorParam.RgbDest) {
					enc.alphaMode = "MASK";
				}
			if(material.passes[0].shader_type == ShaderType.Unlit) {
				enc.extensions = {"KHR_materials_unlit": {}};
			}
			if(material.texture_file >= 0) {
				let pass = material.passes[0];
				let png_name = `bit${material.texture_file}_${GsStorageFormat[pass.texture_format]}_${pass.texture_location}_${pass.clut_location}_${2**pass.texture_log_width}x${2**pass.texture_log_height}.png`;
				let png_index = pngs_included.get(png_name);
				if(png_index == undefined) {
					png_index = this.pngs.length;
					pngs_included.set(png_name, png_index);
					let clut_location = images[material.texture_file].find_location(pass.clut_location);
					assert(clut_location);
					let data = images[material.texture_file].export_indexed_data({
						format: pass.texture_format,
						width: 2**pass.texture_log_width,
						height: 2**pass.texture_log_height,
						is_clut: false,
						location: pass.texture_location[0]
					}, clut_location, false, true);
					let png = new PNG({
						colorType: 6,
						width: 2**pass.texture_log_width,
						height: 2**pass.texture_log_height
					});
					png.data = Buffer.from(data);
					this.pngs.push(png);
					this.png_names.push(png_name);
				}
				enc.pbrMetallicRoughness = {
					baseColorTexture: {index: gltf.textures.length}
				};
				gltf.textures.push({
					source: png_index,
					sampler: gltf.samplers.length
				});
				gltf.samplers.push({
					wrapS: pass.wrap_h == GsWrapMode.REPEAT ? 10497 : 33071,
					wrapT: pass.wrap_v == GsWrapMode.REPEAT ? 10497 : 33071,
					magFilter: pass.mag_filter == GsFilter.NEAREST ? 9728 : 9729,
					minFilter: {
						[GsFilter.NEAREST]: 9728,
						[GsFilter.LINEAR]: 9729,
						[GsFilter.NEAREST_MIPMAP_NEAREST]: 9984,
						[GsFilter.LINEAR_MIPMAP_NEAREST]: 9985,
						[GsFilter.NEAREST_MIPMAP_LINEAR]: 9986,
						[GsFilter.LINEAR_MIPMAP_LINEAR]: 9987,
					}[pass.min_filter]
				});
			}
			gltf.materials.push(enc);
		}

		this.collision_material = gltf.materials.length;
		gltf.materials.push({
			name: "Collision",
			pbrMetallicRoughness: {
				baseColorFactor: [0.8, 0.2, 0.8, 1.0],
				roughnessFactor: 0,
				metallicFactor: 0
			}
		});

		gltf.scene = 0;
		gltf.scenes = [
			this.scene
		];
	}

	add_model(model : ModelChunk) {
		assert(model.root.type == ModelNodeType.Empty);
		for(let zone_group of model.root.children) {
			//scene.nodes?.push(this.encode_node(child, null));
			assert(zone_group.type == ModelNodeType.ZoneGroup);
			let first_item = zone_group.children[0];
			let lodgroup_target = this.scene.nodes;
			let lodgroup_parent_transform = [0,0,0];
			let children_start = 0;
			let zone_group_enc : Node|undefined;
			if(zone_group.zone_id != 0) {
				zone_group_enc = {
					extras: {
						zone_id: zone_group.zone_id
					},
					translation: zone_group.center,
					name: "zone" + zone_group.zone_id + "_" + zone_group.id
				};
				if(zone_group.addr != undefined) zone_group_enc.name += "_0x" + zone_group.addr.toString(16);
				lodgroup_parent_transform = zone_group.center;
				lodgroup_target = zone_group_enc.children = [];
				this.scene.nodes?.push(this.nodes.length);
				this.nodes.push(zone_group_enc);
				if(first_item.type == ModelNodeType.LodGroup && first_item.c3 && first_item.center[0] == zone_group.center[0] && first_item.center[1] == zone_group.center[1] && first_item.center[2] == zone_group.center[2] && (zone_group.children.length == 1 || (first_item.render_distance > 9999.9 && first_item.fade_rate == 0 && first_item.display_mask == 0))) {
					children_start++;
					zone_group_enc.extras.render_distance = first_item.render_distance;
					if(zone_group.children.length == 1) {
						zone_group_enc.extras.fade_rate = first_item.fade_rate;
						zone_group_enc.extras.display_mask = first_item.display_mask;
					}
					if(first_item.c3) {
						zone_group_enc.mesh = this.encode_meshes(first_item.c3, zone_group.center);
					}
				}
			}
			for(let i = children_start; i < zone_group.children.length; i++) {
				let lod_group = zone_group.children[i];
				assert(lod_group.type == ModelNodeType.LodGroup);
				let lod_group_enc : Node = {
					extras: {
						fade_rate: lod_group.fade_rate,
						display_mask: lod_group.display_mask,
						render_distance: lod_group.render_distance
					},
					translation: [
						lod_group.center[0] - lodgroup_parent_transform[0],
						lod_group.center[1] - lodgroup_parent_transform[1],
						lod_group.center[2] - lodgroup_parent_transform[2]
					],
					name: "lod" + lod_group.render_distance + "_" + lod_group.id
				};
				if(lod_group.addr != undefined) lod_group_enc.name += "_0x" + lod_group.addr.toString(16);
				if(lod_group.c3) {
					lod_group_enc.mesh = this.encode_meshes(lod_group.c3, lod_group.center);
				}
				lodgroup_target.push(this.nodes.length);
				this.nodes.push(lod_group_enc);
			}
			if(zone_group_enc) {
				if(zone_group_enc.children && zone_group_enc.children.length == 0) zone_group_enc.children = undefined;
			}
		}
	}

	add_collision(collision : CollisionChunk) {
		for(let [object_index, object] of collision.objects.entries()) {
			let vertices : Vec3[] = [];
			let indices : number[] = [];

			let has_heightmap = object.outer_grid_width > 0 && object.outer_grid_height > 0;

			let loops : [number,number][][] = [];

			let bounds_done = new Set<CollisionBoundary>();
			for(let bound of object.bounds) {
				let inv_mat = matrix_inverse(matrix_transpose([...bound.matrix, 0, 0, 0, 1]));
				assert(inv_mat, "Collision boundary has a degenerate matrix");
				let dl = apply_matrix(inv_mat, [0, 0, 0]);
				let dr = apply_matrix(inv_mat, [0, bound.width, 0]);
				let ur = apply_matrix(inv_mat, [0, bound.width, bound.height]);
				let ul = apply_matrix(inv_mat, [0, 0, bound.height]);

				if(distance_xz_sq(dl, ul) > 0.00001 || distance_xz_sq(dr, ur)  > 0.00001) {
					throw new Error("Encountered unsupported collision object " + object_index + " with non-vertical walls");
				}

				let loop : [number,number][] = [[ul[0], -ul[2]]]
				if(!bounds_done.has(bound)) {
					bounds_done.add(bound);
					let next_bound = bound;
					while(next_bound.to_right != undefined) {
						next_bound = object.bounds[next_bound.to_right];
						if(bounds_done.has(next_bound)) {
							if(next_bound == bound) {
								loop.push(loop[0]);
								loops.push(loop);
							}
							break;
						}
						bounds_done.add(next_bound); 
						let next_inv_mat = matrix_inverse(matrix_transpose([...next_bound.matrix, 0, 0, 0, 1]));
						assert(next_inv_mat, "Collision boundary has a degenerate matrix");
						let next_ul = apply_matrix(next_inv_mat, [0, 0, next_bound.height]);
						loop.push([next_ul[0], -next_ul[2]]);
					}
				}

				let curr_i = vertices.length;
				vertices.push(dl, dr, ur, ul);
				
				indices.push(curr_i, curr_i+1, curr_i+2, curr_i, curr_i+2, curr_i+3);
			}

			if(has_heightmap) {
				let grid_i = 0;
				for(let oy = 0; oy < object.outer_grid_height; oy++) for(let ox = 0; ox < object.outer_grid_width; ox++) {
					let inner_grid = object.heightmap_grid[grid_i++];
					if(!inner_grid) continue;

					let base_x = object.aabb_start[0] + ox*object.outer_tile_size;
					let base_y = object.aabb_start[1] + oy*object.outer_tile_size;

					let big_tile: [number,number][][] = [[
						[base_x, -(base_y)],
						[base_x, -(base_y+object.outer_tile_size)],
						[base_x+object.outer_tile_size, -(base_y+object.outer_tile_size)],
						[base_x+object.outer_tile_size, -(base_y)]
					]];
					big_tile[0].push(big_tile[0][0]);

					if(loops.length && diff(big_tile, loops).length) {
						for(let iy = 0; iy < object.inner_grid_size-1; iy++) for(let ix = 0; ix < object.inner_grid_size-1; ix++) {
							let small_tile: [number,number][][] = [[
								[base_x+ix*object.inner_tile_size, -(base_y+iy*object.inner_tile_size)],
								[base_x+ix*object.inner_tile_size, -(base_y+(iy+1)*object.inner_tile_size)],
								[base_x+(ix+1)*object.inner_tile_size, -(base_y+(iy+1)*object.inner_tile_size)],
								[base_x+(ix+1)*object.inner_tile_size, -(base_y+iy*object.inner_tile_size)],
								[base_x+ix*object.inner_tile_size, -(base_y+iy*object.inner_tile_size)],
							]];
							let intersected = intersection(small_tile, loops) as MultiPolygon;
							if(!intersected) continue;
							for(let sub_tile of intersected) {
								if(!sub_tile) continue;
								//console.log(JSON.stringify(sub_tile));
								sub_tile = sub_tile.filter(i => i.length >= 4);
								for(let item of sub_tile) { // remove duplicate point
									item.length--;
								}
								if(!sub_tile || !sub_tile.length) continue;
								let data = earcut.flatten(sub_tile);
								let triangulation = earcut(data.vertices, data.holes, data.dimensions);
								let poly_indices : number[] = [];
								for(let i = 0; i < data.vertices.length; i += 2) {
									vertices.push([
										data.vertices[i],
										object.get_heightmap_y(data.vertices[i], -data.vertices[i+1], true),
										-data.vertices[i+1]
									]);
									poly_indices.push(vertices.length-1);
								}
								indices.push(...triangulation.map(index => poly_indices[index]));
							}
						}
					} else {
						let curr_i = vertices.length;
						for(let iy = 0; iy < object.inner_grid_size; iy++) for(let ix = 0; ix < object.inner_grid_size; ix++) {
							vertices.push([
								ix*object.inner_tile_size + base_x,
								inner_grid[iy*object.inner_grid_size+ix],
								iy*object.inner_tile_size + base_y
							]);
						}
						for(let iy = 0; iy < object.inner_grid_size-1; iy++) for(let ix = 0; ix < object.inner_grid_size-1; ix++) {
							let base = curr_i + iy*object.inner_grid_size + ix;
							indices.push(base);
							indices.push(base+object.inner_grid_size);
							indices.push(base+1);
							indices.push(base+1);
							indices.push(base+object.inner_grid_size);
							indices.push(base+object.inner_grid_size+1);
						}
					}
				}
			}

			let mesh_primitive : MeshPrimitive = {
				attributes: {
	
				},
				material: this.collision_material
			};

			let indices_dv = new DataView(new ArrayBuffer(indices.length * 4));
			for(let i = 0; i < indices.length; i++) {
				indices_dv.setUint32(i*4, indices[i], true);
			}
			mesh_primitive.indices = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5125,
				type: "SCALAR",
				buffer: indices_dv.buffer,
				count: indices.length
			});

			let flat_verts = vertices.flat();
			let vertices_dv = new DataView(new ArrayBuffer(flat_verts.length * 4));
			for(let i = 0; i < flat_verts.length; i++) {
				vertices_dv.setFloat32(i*4, flat_verts[i], true);
			}
			mesh_primitive.attributes.POSITION = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				type: "VEC3",
				buffer: vertices_dv.buffer,
				count: vertices.length
			});

			this.scene.nodes.push(this.nodes.length);
			let node : Node = {
				mesh: this.meshes.length,
				extras: {}
			};
			this.nodes.push(node);
			this.meshes.push({
				primitives: [mesh_primitive],
				name: `Collision_${object_index}`
			});

			node.extras.collision = true;
			node.extras.collision_mask = object.mask;
			node.extras.drown_target = object.drown_target;
			node.extras.floor_type = FloorType[object.floor_type];
			node.extras.floor_material = FloorMaterial[object.floor_material];
			node.extras.water_splash_object = object.water_splash_object >= 0 ? `Collision_${object.water_splash_object}` : "";
			node.extras.zone_id = object.zone;
			node.extras.heightmap_resolution = object.inner_tile_size;
		}
	}

	finalize() {
		let gltf = this.gltf;
		let png_buffers = this.pngs.map(p => PNG.sync.write(p));

		let total_buffer_length = 0;
		for(let accessor of this.accessor_buffers) {
			total_buffer_length += accessor.buffer.byteLength;
			total_buffer_length = Math.ceil(total_buffer_length / 4) * 4;
		}
		for(let buffer of png_buffers) {
			total_buffer_length += buffer.length;
			total_buffer_length = Math.ceil(total_buffer_length / 4) * 4;
		}

		let buffer = new Uint8Array(total_buffer_length);

		gltf.accessors = [];
		gltf.bufferViews = [];
		gltf.images = [];

		let buffer_offset = 0;
		for(let accessor_buffer of this.accessor_buffers) {
			gltf.accessors.push({
				type: accessor_buffer.type,
				count: accessor_buffer.count,
				componentType: accessor_buffer.componentType,
				normalized: accessor_buffer.normalized,
				bufferView: gltf.bufferViews.length
			});

			gltf.bufferViews.push({
				buffer: 0,
				byteOffset: buffer_offset,
				byteLength: accessor_buffer.buffer.byteLength
			});

			buffer.set(new Uint8Array(accessor_buffer.buffer), buffer_offset);
			
			buffer_offset += accessor_buffer.buffer.byteLength;
			buffer_offset = Math.ceil(buffer_offset / 4) * 4;
		}

		for(let i = 0; i < this.pngs.length; i++) {
			gltf.images.push({
				bufferView: gltf.bufferViews.length,
				mimeType: "image/png",
				name: this.png_names[i]
			});
			gltf.bufferViews.push({
				buffer: 0,
				byteOffset: buffer_offset,
				byteLength: png_buffers[i].length
			});

			buffer.set(png_buffers[i], buffer_offset);

			buffer_offset += png_buffers[i].length;
			buffer_offset = Math.ceil(buffer_offset / 4) * 4;
		}

		gltf.buffers = [
			{
				byteLength: buffer.length
			}
		];

		let json_buffer = new TextEncoder().encode(JSON.stringify(gltf) + "   ");
		let json_len = json_buffer.length & ~3;

		let final_buffer = new Uint8Array(12+8+8+buffer.length+json_len);
		let final_dv = new DataView(final_buffer.buffer);

		final_dv.setUint32(0, 0x46546c67, true);
		final_dv.setUint32(4, 2, true);
		final_dv.setUint32(8, final_buffer.length, true);
		final_dv.setUint32(12, json_len, true);
		final_dv.setUint32(16, 0x4E4F534A, true);
		final_buffer.set(json_buffer, 20);
		final_dv.setUint32(20+json_len, buffer.length, true);
		final_dv.setUint32(24+json_len, 0x004e4942, true);
		final_buffer.set(buffer, 28+json_len);

		return final_buffer;
	}

	pngs : PNG[] = [];
	png_names : string[] = [];

	accessor_buffers : AccessorBuffer[] = [];
	nodes : Node[] = [];
	materials : MaterialsChunk;
	meshes : Mesh[] = [];
	glb_materials : Material[] = [];
	scene = {
		nodes: [] as number[]
	};

	collision_material : number;

	*iterate_meshes(node : ModelNode) : IterableIterator<ModelNodeMesh> {
		if(node.type == ModelNodeType.Mesh) {
			yield node;
		} else if(node.type == ModelNodeType.Empty) {
			for(let child of node.children) yield* this.iterate_meshes(child);
		} else {
			throw new Error("Unexpected model node of type " + ModelNodeType[node.type]);
		}
	}

	encode_node(node : ModelNode, parent_transform : [number,number,number]|null, prefix = "") : number {
		if(!parent_transform) parent_transform = [0,0,0];
		let encoded_node : Node = {
			name: prefix + ModelNodeType[node.type] + "_" + node.id,
			translation: [
				node.center[0] - parent_transform[0],
				node.center[1] - parent_transform[1],
				node.center[2] - parent_transform[2]
			],
			extras: {
				radius: node.radius
			}
		};
		if(node.render_distance != null) encoded_node.extras["render_distance"] = node.render_distance;
		if(node.addr != undefined) encoded_node.name += "_0x" + node.addr.toString(16);
		let children : number[] = [];
		let index = this.nodes.length;
		this.nodes.push(encoded_node);
		for(let child of node.children) {
			children.push(this.encode_node(child, node.center));
		}
		if(node.type == ModelNodeType.LodGroup) {
			if(node.c1) throw new Error("Unsupported LodGroup c1");
			if(node.c2) throw new Error("Unsupported LodGroup c2");
			if(node.c3) children.push(this.encode_node(node.c3, node.center, "c3_"));
			encoded_node.extras.fade_rate = node.fade_rate;
			encoded_node.extras.display_mask = node.display_mask;
		} else if(node.type == ModelNodeType.Mesh) {
			let mesh_primitive = this.make_mesh_primitive(node, node.center);

			encoded_node.mesh =this. meshes.length;

			this.meshes.push({
				primitives: [mesh_primitive]
			});
		} else if(node.type == ModelNodeType.ZoneGroup) {
			encoded_node.extras["zone_id"] = node.zone_id;
		}
		if(children.length) encoded_node.children = children;
		return index;
	}

	encode_meshes(node : ModelNode, center : [number,number,number]) : number|undefined {
		let primitives = [];
		for(let child of this.iterate_meshes(node)) {
			primitives.push(this.make_mesh_primitive(child, center));
		}
		if(primitives.length) {
			let mesh = this.meshes.length;
			this.meshes.push({primitives});
			return mesh;
		}
	}

	make_mesh_primitive(node : ModelNodeMesh, center : [number,number,number]) : MeshPrimitive {
		let material = this.materials.materials[node.material];
		let shader_type = material.passes[0].shader_type;
		let buffer_list : BufferList = {num_vertices: new Uint8Array(node.initial_state)[0], vertex_start : 0};
		let buffer_lists : BufferList[] = [];
		let start_addr = (node.initial_state.byteLength / 16)|0;
		for(let item of node.vif_code) {
			if(item.type == VifCodeType.UNPACK) {
				if(item.vn == 3 && item.vl == 0 && item.location == 0) {
					buffer_list.num_vertices = new Uint8Array(item.data)[0];
					continue;
				}
				let which = (item.location - start_addr) / buffer_list.num_vertices;
				let size = item.num / buffer_list.num_vertices
				if(which == 0 && item.vn == 2 && item.vl == 0) {
					buffer_list.vertices = item.data;
				} else if(which == 0 && item.vn == 0 && item.vl == 2) {
					buffer_list.kick_flags = item.data;
				} else if(which == 1 && item.vn == 3 && item.vl == 2) {
					buffer_list.colors = item.data;
				} else if(which == 2 && item.vn == 2 && item.vl == 0 && shader_type != ShaderType.Unlit) {
					buffer_list.normals = item.data;
				} else if(item.vn == 1 && item.vl == 0) {
					if(size == 2) {
						buffer_list.uv = item.data.slice(0, 8*buffer_list.num_vertices);
						buffer_list.uv2 = item.data.slice(8*buffer_list.num_vertices, 16*buffer_list.num_vertices);
					} else {
						buffer_list.uv = item.data;
					}
				} else if(which == 3 && item.vn == 2 && item.vl == 0 && shader_type == ShaderType.LitRigged) {
					buffer_list.weights = item.data;
				} else if(which == 4 && item.vn == 3 && item.vl == 2 && shader_type == ShaderType.LitRigged) {
					buffer_list.joints = item.data;
				}
			} else if(item.type == VifCodeType.MSCNT) {
				buffer_lists.push({...buffer_list});
				buffer_list.vertex_start += buffer_list.num_vertices;
			}
		}
		buffer_lists.push({...buffer_list});
		buffer_list.vertex_start += buffer_list.num_vertices;

		let mesh_primitive : MeshPrimitive = {
			attributes: {

			},
			material: node.material
		}

		let verts_dv = new DataView(new ArrayBuffer(buffer_list.vertex_start * 12));
		let index = 0;
		for(let list of buffer_lists) {
			assert(list.vertices != null)
			let in_dv = new DataView(list.vertices);
			for(let i = 0; i < list.num_vertices; i++) {
				for(let j = 0; j < 3; j++) {
					verts_dv.setFloat32(index*12+j*4, in_dv.getFloat32(i*12+j*4, true) - center[j], true);
				}
				index++;
			}
		}
		mesh_primitive.attributes.POSITION = this.accessor_buffers.length;
		this.accessor_buffers.push({
			componentType: 5126,
			buffer: verts_dv.buffer,
			count: buffer_list.vertex_start,
			type: "VEC3"
		});

		if(buffer_list.normals) {
			let normals_buffer = array_buffer_concat(...buffer_lists.map(item => {
				assert(item.normals);
				return item.normals;
			}));
			mesh_primitive.attributes.NORMAL = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				buffer: normals_buffer,
				count: buffer_list.vertex_start,
				type: "VEC3"
			});
		}
		
		if(buffer_list.uv) {
			let uv_buffer = array_buffer_concat(...buffer_lists.map(item => {
				assert(item.uv);
				return item.uv;
			}));
			mesh_primitive.attributes.TEXCOORD_0 = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				buffer: uv_buffer,
				count: buffer_list.vertex_start,
				type: "VEC2"
			});
		}

		if(buffer_list.uv2) {
			let uv2_buffer = array_buffer_concat(...buffer_lists.map(item => {
				assert(item.uv2);
				return item.uv2;
			}));
			mesh_primitive.attributes.TEXCOORD_1 = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				buffer: uv2_buffer,
				count: buffer_list.vertex_start,
				type: "VEC2"
			});
		}

		if(buffer_list.colors) {
			let colors_dv = new DataView(new ArrayBuffer(buffer_list.vertex_start * 16));
			index = 0;
			let one_level = shader_type == ShaderType.Unlit ? 0x80 : 0x10;
			let multiplier = material.texture_file >= 0 ? 1 : 0.5;
			for(let list of buffer_lists) {
				assert(list.colors != null);
				let in_arr = new Uint8Array(list.colors);
				for(let i = 0; i < list.num_vertices; i++) {
					colors_dv.setFloat32(index*16+0, srgb_to_linear(in_arr[i*4+0] / one_level * multiplier), true)
					colors_dv.setFloat32(index*16+4, srgb_to_linear(in_arr[i*4+1] / one_level * multiplier), true)
					colors_dv.setFloat32(index*16+8, srgb_to_linear(in_arr[i*4+2] / one_level * multiplier), true)
					let alpha = Math.min(1, in_arr[i*4+3] / one_level);
					colors_dv.setFloat32(index*16+12, alpha, true)
					if(alpha < 1 && this.glb_materials[node.material].alphaMode == "MASK") this.glb_materials[node.material].alphaMode = "BLEND"
					index++;
				}
			}
			mesh_primitive.attributes.COLOR_0 = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				buffer: colors_dv.buffer,
				count: buffer_list.vertex_start,
				type: "VEC4",
				normalized: true
			});
		}

		if(buffer_list.weights) {
			let weights_buffer = array_buffer_concat(...buffer_lists.map(item => {
				assert(item.weights);
				return item.weights;
			}));
			mesh_primitive.attributes.WEIGHTS_0 = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				buffer: weights_buffer,
				count: buffer_list.vertex_start,
				type: "VEC3"
			});
		}

		if(buffer_list.joints) {
			let joints_buffer = array_buffer_concat(...buffer_lists.map(item => {
				assert(item.joints);
				return item.joints;
			}));
			mesh_primitive.attributes.JOINTS_0 = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5121,
				buffer: joints_buffer,
				count: buffer_list.vertex_start,
				type: "VEC4"
			});
		}

		let indices : number[] = [];
		for(let list of buffer_lists) {
			assert(list.kick_flags);
			let flags_arr = new Uint8Array(list.kick_flags);
			let is_first = true;
			let curr_start_index = 0;
			for(let i = 2; i < list.num_vertices; i++) {
				if(flags_arr[i] >= 0x80) {
					is_first = true;
					continue;
				}
				if(is_first) {
					curr_start_index = i;
					is_first = false;
				}
				if((i - curr_start_index) % 2) { // try to get some semblance of consistency with normals.
					indices.push(list.vertex_start+i-2);
					indices.push(list.vertex_start+i-1);
				} else {
					indices.push(list.vertex_start+i-1);
					indices.push(list.vertex_start+i-2);
				}
				indices.push(list.vertex_start+i);
			}
		}

		let indices_dv = new DataView(new ArrayBuffer(indices.length * 4));
		for(let i = 0; i < indices.length; i++) {
			indices_dv.setUint32(i*4, indices[i], true);
		}
		mesh_primitive.indices = this.accessor_buffers.length;
		this.accessor_buffers.push({
			componentType: 5125,
			type: "SCALAR",
			buffer: indices_dv.buffer,
			count: indices.length
		});
		return mesh_primitive
	}
}

function array_buffer_concat(...buffers : ArrayBuffer[]) {
	let total_len = 0;
	for(let buffer of buffers) {
		total_len += buffer.byteLength;
	}
	let buf = new Uint8Array(total_len);
	let ptr = 0;
	for(let buffer of buffers) {
		buf.set(new Uint8Array(buffer), ptr);
		ptr += buffer.byteLength;
	}
	return buf.buffer;
}

interface BufferList {
	vertices? : ArrayBuffer;
	normals? : ArrayBuffer;
	colors? : ArrayBuffer;
	kick_flags? : ArrayBuffer;
	uv? : ArrayBuffer;
	uv2? : ArrayBuffer;
	joints? : ArrayBuffer;
	weights? : ArrayBuffer;
	num_vertices : number;
	vertex_start : number;
}

interface AccessorBuffer {
	componentType: 5120|5121|5122|5123|5125|5126;
	buffer : ArrayBuffer;
	normalized? : boolean;
	count : number;
	type : "SCALAR"|"VEC2"|"VEC3"|"VEC4"|"MAT2"|"MAT3"|"MAT4";
};
