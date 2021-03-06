import assert from "assert";
import { diff, intersection, MultiPolygon } from "martinez-polygon-clipping";
import { PNG } from "pngjs";
import { CollisionBoundary, CollisionChunk, FloorMaterial, FloorType } from "../chunks/collision.js";
import { ImageChunk } from "../chunks/image.js";
import { MaterialsChunk, ShaderType } from "../chunks/materials.js";
import { BufferList, ModelChunk, ModelNode, ModelNodeMesh, ModelNodeType } from "../chunks/model.js";
import { GsAlphaParam, GsColorParam, GsFilter, GsStorageFormat, GsWrapMode } from "../ps2/gs_constants.js";
import { VifCodeType } from "../ps2/vifcode.js";
import { apply_matrix, cross_product, distance_xz_sq, dot_product, matrix_inverse, matrix_transpose, normalize_vector, srgb_to_linear, Vec3 } from "../utils/misc.js";
import { GlTf, Material, Mesh, MeshPrimitive, Node, Scene } from "./gltf.js";
import earcut from "earcut";
import { Light, LightsChunk, LightType } from "../chunks/lights.js";

export function export_gltf(materials : MaterialsChunk, images : ImageChunk[], parts : GlTfExportParts) {
	let exporter = new GlTfExporter(materials, images);
	if(parts.model) exporter.add_model(parts.model);
	if(parts.collision) exporter.add_collision(parts.collision);
	if(parts.lights) exporter.add_lights(parts.lights);
	return exporter.finalize();
}

export interface GlTfExportParts {
	model? : ModelChunk;
	collision? : CollisionChunk;
	lights? : LightsChunk;
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
					if(!clut_location) clut_location = {format: GsStorageFormat.PSMCT32, width:16,height:16,is_clut:true,location:pass.clut_location};
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
			assert(zone_group.type == ModelNodeType.ZoneGroup || zone_group.type == ModelNodeType.Empty, "Expected empty or zone group as child of root node in model");
			let first_item = zone_group.children[0];
			let lodgroup_target = this.scene.nodes;
			let lodgroup_parent_transform = [0,0,0];
			let children_start = 0;
			let zone_group_enc : Node|undefined;
			if(zone_group.type == ModelNodeType.ZoneGroup && zone_group.zone_id != 0) {
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
						zone_group_enc.extras.sort_order = first_item.sort_order;
					}
					if(first_item.c3) {
						this.max_bone_used = -1;
						zone_group_enc.mesh = this.encode_meshes(first_item.c3, zone_group.center);
						if(this.max_bone_used >= 0) {
							zone_group_enc.skin = this.get_skin(this.max_bone_used);
							if(this.dummy_skeleton) this.dummy_skeleton.translation = zone_group_enc.translation;
						}
					}
					if(first_item.c2) throw new Error("Unexpected c2 on node " + first_item.addr?.toString(16));
					if(first_item.c1) throw new Error("Unexpected c1 on node " + first_item.addr?.toString(16));
				}
			}
			for(let i = children_start; i < zone_group.children.length; i++) {
				let lod_group = zone_group.children[i];
				assert(lod_group.type == ModelNodeType.LodGroup);
				let lod_group_enc : Node = {
					extras: {
						fade_rate: lod_group.fade_rate,
						display_mask: lod_group.display_mask,
						render_distance: lod_group.render_distance,
						sort_order: lod_group.sort_order
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
					this.max_bone_used = -1;
					lod_group_enc.mesh = this.encode_meshes(lod_group.c3, lod_group.center);
					if(this.max_bone_used >= 0) {
						lod_group_enc.skin = this.get_skin(this.max_bone_used);
						if(this.dummy_skeleton) this.dummy_skeleton.translation = lod_group_enc.translation;
					}
				}
				if(lod_group.c2) throw new Error("Unexpected c2 on node " + lod_group.addr?.toString(16));
				if(lod_group.c1) throw new Error("Unexpected c1 on node " + lod_group.addr?.toString(16));
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
			let {vertices, indices} = object.to_mesh(object_index);

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

			let vertices_dv = new DataView(new ArrayBuffer(vertices.length * 4));
			for(let i = 0; i < vertices.length; i++) {
				vertices_dv.setFloat32(i*4, vertices[i], true);
			}
			mesh_primitive.attributes.POSITION = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				type: "VEC3",
				buffer: vertices_dv.buffer,
				count: vertices.length/3
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

	add_lights(lights : LightsChunk) {
		for(let i = 0; i < lights.groups.length; i++) {
			let group = lights.groups[i];
			if(group.lights) {
				for(let j = 0; j < group.lights.length; j++) {
					this.scene.nodes.push(this.add_light_node(group.lights[j], `${i}_${j}`));
				}
			}
			if(group.base_lights) {
				for(let j = 0; j < group.base_lights.length; j++) {
					this.scene.nodes.push(this.add_light_node(group.base_lights[j], `${i}_${j}`, "Base_"));
				}
			}
			if(group.base_ambient_light) {
				this.scene.nodes.push(this.add_light_node(group.base_ambient_light, i, "BaseAmbient_"));
			}
		}
	}

	add_light_node(light : Light, id : number|string, name_prefix = "", base_position? : Vec3) : number {
		let light_obj = {
			"type": light.type === LightType.Directional ? "directional" : "point",
			"intensity": light.intensity**2 * (light.type === LightType.Directional ? 40 : 40000),
			"range": light.range > 0 ? light.range : undefined,
			"color": light.color.map(a => srgb_to_linear(a/255)),
			"extras": {} as any
		};
		if(light.type === LightType.Ambient) {
			light_obj.extras.ambient = true;
		}
		let light_index = this.lights.length;
		this.lights.push(light_obj);
		
		let dir_vec = light.direction.map(a => -a) as [number,number,number];
		let dir_perp_1 = normalize_vector(cross_product(dir_vec, [dir_vec[1], dir_vec[2], dir_vec[0]]));
		let dir_perp_2 = normalize_vector(cross_product(dir_vec, dir_perp_1));
		let node : Node = {
			matrix: [
				...dir_perp_1, 0,
				...dir_perp_2, 0,
				...dir_vec, 0,
				...light.position, 1
			],
			name: `${name_prefix}${LightType[light.type]}${id}`,
			extras: {
				zone_id: light.zone_id
			},
			extensions: {
				"KHR_lights_punctual": {
					light: light_index
				}
			}
		};
		let node_index = this.nodes.length;
		this.nodes.push(node);
		return node_index;
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

	max_bone_used = -1;
	dummy_skeleton_index : number|undefined = undefined;
	dummy_skeleton : Node|undefined = undefined;
	skin : number|undefined = undefined;

	collision_material : number;

	get_skin(max_bone_used : number) {
		if(!this.dummy_skeleton || this.dummy_skeleton_index == undefined) {
			this.dummy_skeleton_index = this.nodes.length;
			this.dummy_skeleton = {
				name: "Dummy Skeleton"
			}
			this.nodes.push(this.dummy_skeleton);
			this.scene.nodes.push(this.dummy_skeleton_index);
		}
		if(!this.dummy_skeleton.children) this.dummy_skeleton.children = [];
		while(max_bone_used >= this.dummy_skeleton.children.length) {
			let index = this.nodes.length;
			let bone_index = this.dummy_skeleton.children.length;
			this.dummy_skeleton.children.push(index);
			this.nodes.push(
				{
					name: "bone_" + bone_index,
					extras: {"ntdf_bone_index": bone_index}
				}
			);
		}
		
		if(this.skin == undefined) {
			if(!this.gltf.skins) this.gltf.skins = [];
			this.skin = this.gltf.skins.length;
			this.gltf.skins.push({
				joints: this.dummy_skeleton.children,
				skeleton: this.dummy_skeleton_index
			});
		}
		return this.skin;
	}

	get lights() : any[] {
		if(!this.gltf.extensions) {
			this.gltf.extensions = {};
		}
		if(!this.gltf.extensions["KHR_lights_punctual"]) {
			this.gltf.extensions["KHR_lights_punctual"] = {};
		}
		if(!this.gltf.extensions["KHR_lights_punctual"].lights) {
			this.gltf.extensions["KHR_lights_punctual"].lights = [];
		}
		return this.gltf.extensions["KHR_lights_punctual"].lights;
	}

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
		} else {
			throw new Error("Unsupported node type " + node.type + " at " + node.addr?.toString(16));
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
		let [buffer_lists, total_verts] = ModelChunk.get_mesh_buffers(node);

		let mesh_primitive : MeshPrimitive = {
			attributes: {

			},
			material: node.material
		}

		let verts_dv = new DataView(new ArrayBuffer(total_verts * 12));
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
			count: total_verts,
			type: "VEC3"
		});

		let normals_arr : number[] = [];
		if(buffer_lists[0].normals) {
			let normals_buffer = array_buffer_concat(...buffer_lists.map(item => {
				assert(item.normals);
				return item.normals;
			}));
			let normals_dv = new DataView(normals_buffer);
			for(let i = 0; i < normals_buffer.byteLength; i += 4) {
				normals_arr.push(normals_dv.getFloat32(i, true));
			}
			mesh_primitive.attributes.NORMAL = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				buffer: normals_buffer,
				count: total_verts,
				type: "VEC3"
			});
		}
		
		if(buffer_lists[0].uv) {
			let uv_buffer = array_buffer_concat(...buffer_lists.map(item => {
				assert(item.uv);
				return item.uv;
			}));
			mesh_primitive.attributes.TEXCOORD_0 = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				buffer: uv_buffer,
				count: total_verts,
				type: "VEC2"
			});
		}

		if(buffer_lists[0].uv2) {
			let uv2_buffer = array_buffer_concat(...buffer_lists.map(item => {
				assert(item.uv2);
				return item.uv2;
			}));
			mesh_primitive.attributes.TEXCOORD_1 = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				buffer: uv2_buffer,
				count: total_verts,
				type: "VEC2"
			});
		}

		if(buffer_lists[0].colors) {
			let colors_dv = new DataView(new ArrayBuffer(total_verts * 16));
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
				count: total_verts,
				type: "VEC4",
				normalized: true
			});
		}

		if(buffer_lists[0].weights) {
			let weights_dv = new DataView(new ArrayBuffer(total_verts * 16));
			let index = 0;
			for(let list of buffer_lists) {
				assert(list.weights != null)
				let in_dv = new DataView(list.weights);
				for(let i = 0; i < list.num_vertices; i++) {
					for(let j = 0; j < 3; j++) {
						weights_dv.setFloat32(index*16+j*4, in_dv.getFloat32(i*12+j*4, true), true);
					}
					weights_dv.setFloat32(index*16+12, 0, true);
					index++;
				}
			}

			mesh_primitive.attributes.WEIGHTS_0 = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5126,
				buffer: weights_dv.buffer,
				count: total_verts,
				type: "VEC4"
			});
		}

		if(buffer_lists[0].joints) {
			let joints_buffer = array_buffer_concat(...buffer_lists.map(item => {
				assert(item.joints);
				return item.joints;
			}));
			let joints_arr = new Uint8Array(joints_buffer);
			for(let i = 3; i < joints_arr.length; i += 4) joints_arr[i] = 0;
			for(let i = 0; i < joints_arr.length; i++) {
				this.max_bone_used = Math.max(this.max_bone_used, joints_arr[i]);
			}
			mesh_primitive.attributes.JOINTS_0 = this.accessor_buffers.length;
			this.accessor_buffers.push({
				componentType: 5121,
				buffer: joints_buffer,
				count: total_verts,
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
				let swap_order = !((i - curr_start_index) % 2);
				if(normals_arr.length) {
					let base = [
						verts_dv.getFloat32((list.vertex_start+i-2)*12 + 0, true),
						verts_dv.getFloat32((list.vertex_start+i-2)*12 + 4, true),
						verts_dv.getFloat32((list.vertex_start+i-2)*12 + 8, true),
					] as Vec3;
					let vec1 = [
						verts_dv.getFloat32((list.vertex_start+i-1)*12 + 0, true) - base[0],
						verts_dv.getFloat32((list.vertex_start+i-1)*12 + 4, true) - base[1],
						verts_dv.getFloat32((list.vertex_start+i-1)*12 + 8, true) - base[2],
					] as Vec3;
					let vec2 = [
						verts_dv.getFloat32((list.vertex_start+i)*12 + 0, true) - base[0],
						verts_dv.getFloat32((list.vertex_start+i)*12 + 4, true) - base[1],
						verts_dv.getFloat32((list.vertex_start+i)*12 + 8, true) - base[2],
					] as Vec3;
					let calc_normal = cross_product(vec1, vec2);

					let avg_normal = [
						normals_arr[(list.vertex_start+i-2)*3 + 0] + normals_arr[(list.vertex_start+i-1)*3 + 0] + normals_arr[(list.vertex_start+i)*3 + 0],
						normals_arr[(list.vertex_start+i-2)*3 + 1] + normals_arr[(list.vertex_start+i-1)*3 + 1] + normals_arr[(list.vertex_start+i)*3 + 1],
						normals_arr[(list.vertex_start+i-2)*3 + 2] + normals_arr[(list.vertex_start+i-1)*3 + 2] + normals_arr[(list.vertex_start+i)*3 + 2],
					] as Vec3;
					swap_order = dot_product(avg_normal, calc_normal) < 0;
				}
				if(!swap_order) { // try to get some semblance of consistency with normals.
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


interface AccessorBuffer {
	componentType: 5120|5121|5122|5123|5125|5126;
	buffer : ArrayBuffer;
	normalized? : boolean;
	count : number;
	type : "SCALAR"|"VEC2"|"VEC3"|"VEC4"|"MAT2"|"MAT3"|"MAT4";
};
