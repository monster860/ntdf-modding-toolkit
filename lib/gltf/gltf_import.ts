import assert from "assert";
import { MaterialsChunk, ShaderType } from "../chunks/materials.js";
import { ModelChunk, ModelNode, ModelNodeEmpty, ModelNodeLodGroup, ModelNodeMesh, ModelNodeType, ModelNodeZoneGroup } from "../chunks/model.js";
import { GsColorParam } from "../ps2/gs_constants.js";
import { VifCode, VifCodeType } from "../ps2/vifcode.js";
import { apply_matrix, identity_matrix, insert_bits, linear_to_srgb, Matrix, matrix_multiply, srgb_to_linear, transform_to_matrix, Vec3, Vec4 } from "../utils/misc.js";
import { GlTf, MeshPrimitive, Node } from "./gltf.js";

export function import_gltf(glb_buffer : ArrayBuffer, materials : MaterialsChunk) : ModelChunk {
	return new GlTfImporter(glb_buffer, materials).model;
}

class GlTfImporter {
	materials : MaterialsChunk;
	gltf : GlTf;
	glb_dv : DataView;
	binary_offset : number;
	model : ModelChunk;
	root : ModelNodeEmpty;
	id_ctr = 0;
	scene_nodes : number[];
	all_nodes : Node[];

	constructor(glb_buffer : ArrayBuffer, materials : MaterialsChunk) {
		this.materials = materials;
		let glb_dv = this.glb_dv = new DataView(glb_buffer);
		assert.strictEqual(glb_dv.getUint32(0, true), 0x46546C67, "Not a Binary glTF file");
		assert.strictEqual(glb_dv.getUint32(4, true), 2, "Bad glTF version");
		let glb_length = glb_dv.getUint32(8, true);
		let glb_chunk_pointer = 12;

		let gltf : GlTf|undefined;
		let binary_offset = 0;

		while(glb_chunk_pointer < glb_length) {
			let chunk_length = glb_dv.getUint32(glb_chunk_pointer, true);
			let chunk_type = glb_dv.getUint32(glb_chunk_pointer+4, true);
			assert.strictEqual((chunk_length % 4), 0, "Misaligned chunks");
			if(chunk_type == 0x4e4f534a) {
				let text = new TextDecoder().decode(new Uint8Array(glb_buffer, glb_chunk_pointer+8, chunk_length));
				gltf = JSON.parse(text);
			} else if(chunk_type == 0x4E4942) {
				binary_offset = glb_chunk_pointer+8;
			}
			glb_chunk_pointer += chunk_length+8;
		}
		this.binary_offset = binary_offset;
		assert(gltf);
		this.gltf = gltf;
		this.root = {
			bounds_origin: [0,0,0],
			bounds_size: [0,0,0],
			center: [0,0,0],
			children: [],
			id: this.id_ctr++,
			radius: 0,
			type: ModelNodeType.Empty,
			render_distance: 1e4
		}
		this.model = new ModelChunk(this.root);

		assert(gltf.scenes, "This glTF file is missing a scene!");
		let scene = gltf.scenes[gltf.scene ?? 0];

		assert(gltf.nodes, "This glTF file has no nodes!");
		this.all_nodes = gltf.nodes;
		assert(scene.nodes, "The scene in the glTF file has no nodes!");
		this.scene_nodes = scene.nodes;
		for(let nodeid of this.scene_nodes) {
			let node = this.all_nodes[nodeid];
			this.propogate_transform(node);
		}

		for(let zone_holder of this.zone_holders) {
			if(!zone_holder) continue;
			let zone : ModelNodeZoneGroup = {
				bounds_origin: [0,0,0],
				bounds_size: [0,0,0],
				center: [0,0,0],
				children: [],
				id: this.id_ctr++,
				radius: 0,
				type: ModelNodeType.ZoneGroup,
				zone_id: zone_holder.zone_id,
				render_distance: 1e4
			};
			this.root.children.push(zone);
			zone_holder.lod_groups.sort((a, b) => b.render_distance - a.render_distance);
			for(let lod_group_holder of zone_holder.lod_groups) {
				if(!lod_group_holder.nodes.length) continue;
				let lod_group : ModelNodeLodGroup = {
					type: ModelNodeType.LodGroup,
					bounds_origin: [0,0,0],
					bounds_size: [0,0,0],
					center: [0,0,0],
					children: [],
					id: this.id_ctr++,
					radius: 0,
					display_mask: lod_group_holder.display_mask,
					fade_rate: lod_group_holder.fade_rate,
					render_distance: lod_group_holder.render_distance,
					c1: null,
					c2: null,
					c3: this.encode_meshes(lod_group_holder.nodes),
				};
				zone.children.push(lod_group);
			}
			zone.children.sort()
		}

		console.log("Average strip length: " + (this.total_strip_length / this.total_strips).toFixed(2));

		this.propogate_attributes(this.root);
	}

	propogate_attributes(node : ModelNode, render_distance = 1e4) {
		if(node.render_distance == undefined) node.render_distance = render_distance;
		else render_distance = node.render_distance;
		if(node.type == ModelNodeType.Mesh) return;
		let all_children = [...node.children];
		if(node.type == ModelNodeType.LodGroup) {
			if(node.c1) all_children.push(node.c1);
			if(node.c2) all_children.push(node.c2);
			if(node.c3) all_children.push(node.c3);
		}
		let center:Vec3 = [0,0,0];
		let bounds_start:Vec3 = [1e6,1e6,1e6];
		let bounds_end:Vec3 = [-1e6,-1e6,-1e6];
		let inv_len = 1/all_children.length;
		for(let child of all_children) {
			this.propogate_attributes(child);
			for(let i = 0; i < 3; i++) {
				center[i] += child.center[i] * inv_len;
				bounds_start[i] = Math.min(bounds_start[i], child.bounds_origin[i]);
				bounds_end[i] = Math.max(bounds_end[i], child.bounds_origin[i]+child.bounds_size[i]);
			}
		}
		node.center = center;
		node.bounds_origin = bounds_start;
		node.bounds_size = [
			bounds_end[0] - bounds_start[0],
			bounds_end[1] - bounds_start[1],
			bounds_end[2] - bounds_start[2],
		];
		let radius = 0;
		for(let child of all_children) {
			let dx = child.center[0]-center[0];
			let dy = child.center[1]-center[1];
			let dz = child.center[2]-center[2];
			radius = Math.max(radius, Math.sqrt(dx*dx + dy*dy + dz*dz)+child.radius);
		}
		node.radius = radius;
	}

	encode_meshes(nodes : Node[]) : ModelNode {
		let all_meshes = this.gltf.meshes ?? [];

		let primitives : MeshPrimitive[] = [];
		let primitive_transforms = new Map<MeshPrimitive, Matrix>();
		for(let node of nodes) {
			if(node.mesh != undefined) {
				let mesh = all_meshes[node.mesh]
				assert(mesh, "Missing mesh " + node.mesh);
				let transform = this.absolute_transforms.get(node);
				assert(transform);
				for(let primitive of mesh.primitives) {
					primitives.push(primitive);
					primitive_transforms.set(primitive, transform);
				}
			}
		}

		primitives.sort((a, b) => {
			let a_material_index = this.get_ntdf_material_index(a);
			let b_material_index = this.get_ntdf_material_index(b);
			let tex_diff = this.materials.materials[a_material_index].texture_file - this.materials.materials[b_material_index].texture_file;
			/* I'm not sure if this is entirely necessary, but this separates the
			  texture files to possibly avoid having to swap them a lot, since I'm
			  pretty sure that's a performance penalty */
			if(tex_diff) return tex_diff;
			return a_material_index-b_material_index;
		});

		let out_nodes : ModelNode[] = [];

		for(let primitive of primitives) {
			let transform = primitive_transforms.get(primitive);
			assert(transform);
			out_nodes.push(...this.encode_primitive(primitive, transform));
		}

		if(out_nodes.length == 1) return out_nodes[0];
		return {
			type: ModelNodeType.Empty,
			bounds_origin: [0,0,0],
			bounds_size: [0,0,0],
			center: [0,0,0],
			children: out_nodes,
			id: this.id_ctr++,
			radius: 0
		};
	}

	encode_primitive(primitive : MeshPrimitive, transform : Matrix) : ModelNode[] {
		if(primitive.mode && primitive.mode < 4) return []; // No lines and points. At least for now.
		let ntdf_material_index = this.get_ntdf_material_index(primitive);
		let ntdf_material = this.materials.materials[ntdf_material_index];
		let shader_type = ntdf_material.passes[0].shader_type;

		let vif_code : VifCode[] = [];
		let qwords_per_vertex = 2;
		qwords_per_vertex += ntdf_material.passes.length;
		if(shader_type == ShaderType.Lit) qwords_per_vertex++;		
		else if(shader_type == ShaderType.LitRigged) qwords_per_vertex += 3;
		else if(shader_type == ShaderType.WaterSheen) qwords_per_vertex++;
		let max_vertices_per_part = Math.floor((205 - ntdf_material.passes.length) / qwords_per_vertex);

		let strips = this.stripify_primitive(primitive, max_vertices_per_part);
		if(!strips.length) return [];

		let initial_state = new Uint8Array(16 * ntdf_material.passes.length);
		for(let i = 0; i < ntdf_material.passes.length; i++) {
			let pass = ntdf_material.passes[i];
			let prim = 0b1100;
			if(i == 0) prim |= 0x200;
			if(pass.alpha_blend_a != pass.alpha_blend_b || pass.alpha_blend_d != GsColorParam.RgbSource) {
				prim |= 0x40; // enable alpha blending if the blending equation is non-trivial
			}
			if(ntdf_material.texture_file >= 0) prim |= 0x10;
			insert_bits(initial_state, i*16, 46, 1, 1); // enable PRIM field
			insert_bits(initial_state, i*16, 47, 11, prim);
			insert_bits(initial_state, i*16, 15, 1, 1); // set EOP
			insert_bits(initial_state, i*16, 60, 4, 3); // NREG = 3
			initial_state[i*16+5] |= 4 // make sure the VU1 microcode runs correct code
			if(i != ntdf_material.passes.length-1) initial_state[i*16+5] |= 0x10 // inform the VU1 microcode theres additional pass.
			// Populate which GS registers to write to
			initial_state[i*16+8] = 0x12;
			initial_state[i*16+9] = 0x5;

		}
		initial_state[0xC] = ntdf_material.passes.length;
		initial_state[0xD] = initial_state[0xC];

		assert(primitive.attributes.POSITION != undefined);
		let positions = this.get_accessor(primitive.attributes.POSITION).data;
		let normals = primitive.attributes.NORMAL != undefined ? this.get_accessor(primitive.attributes.NORMAL).data : undefined;
		let colors = primitive.attributes.COLOR_0 != undefined ? this.get_accessor(primitive.attributes.COLOR_0).data : undefined;
		//if(colors) for(let i = 0; i < colors.length; i++) if((i % 4) != 3) colors[i] = Math.random();
		let has_alpha = colors?.length != positions.length;
		let texcoords : number[][] = [];
		for(let i = 0; i < 2; i++) {
			if(primitive.attributes["TEXCOORD_" + i] != undefined)
				texcoords.push(this.get_accessor(primitive.attributes["TEXCOORD_"+i]).data);
		}

		let center : Vec3 = [0,0,0];
		let bound_start : Vec3 = [1e6,1e6,1e6];
		let bound_end : Vec3 = [-1e6,-1e6,-1e6];
		for(let i = 0; i < positions.length; i += 3) {
			let pos = apply_matrix(transform, [positions[i],positions[i+1],positions[i+2]]);
			for(let j = 0; j < 3; j++) {
				center[j] += pos[j];
				bound_start[j] = Math.min(bound_start[j], pos[j]);
				bound_end[j] = Math.max(bound_end[j], pos[j]);
			}
		}
		center[0] *= 3/positions.length;
		center[1] *= 3/positions.length;
		center[2] *= 3/positions.length;

		let radius_sq = 0;

		for(let i = 0; i < positions.length; i += 3) {
			let pos = apply_matrix(transform, [positions[i],positions[i+1],positions[i+2]]);
			let dx = pos[0] - center[0];
			let dy = pos[1] - center[1];
			let dz = pos[2] - center[2];
			radius_sq = Math.max(radius_sq, dx*dx+dy*dy+dz*dz);
		}

		let strip_index = 0;
		while(strip_index < strips.length) {
			let kick_flags : number[] = [];
			let part_indices : number[] = [];
			assert(strips[strip_index].length <= max_vertices_per_part, "Strip length " + strips[strip_index].length + " exceeds length " + max_vertices_per_part);
			do {
				let strip = strips[strip_index];
				let start = 0;
				if(part_indices.length && part_indices[part_indices.length-1] == strip[0]) start++;
				for(let i = start; i < strip.length; i++) {
					kick_flags.push(i < 2 ? 0x80 : 0);
					part_indices.push(strip[i]);
				}
				strip_index++;
			} while(strip_index < strips.length && part_indices.length + strips[strip_index].length - +(part_indices[part_indices.length-1] == strips[strip_index][0]) < max_vertices_per_part)

			assert(part_indices.length <= max_vertices_per_part, "Part length " + part_indices.length + " exceeds length " + max_vertices_per_part);
			let gif_tag = initial_state;
			if(vif_code.length) {
				vif_code.push({
					type: VifCodeType.MSCNT,
					immediate: 0,
					interrupt: false,
					num: 0
				});
				gif_tag = gif_tag.slice();
				vif_code.push({
					type: VifCodeType.UNPACK,
					data: gif_tag.buffer,
					interrupt: false,
					location: 0,
					masked: false,
					num: ntdf_material.passes.length,
					unsigned: false,
					use_tops: true,
					vl: 0,
					vn: 3
				});
			}
			gif_tag[4] = part_indices.length;
			for(let i = 0; i < ntdf_material.passes.length; i++) gif_tag[i*16] = part_indices.length;
			let location = ntdf_material.passes.length;
			vif_code.push({type: VifCodeType.STMASK, interrupt: false, mask: 0x3F3F3F3F});

			let position_dv = new DataView(new ArrayBuffer(part_indices.length*12));
			for(let i = 0; i < part_indices.length; i++) {
				let pos : Vec3 = [positions[part_indices[i]*3], positions[part_indices[i]*3+1], positions[part_indices[i]*3+2]];
				pos = apply_matrix(transform, pos, true);
				position_dv.setFloat32(i*12, pos[0], true);
				position_dv.setFloat32(i*12+4, pos[1], true);
				position_dv.setFloat32(i*12+8, pos[2], true);
			}
			vif_code.push({
				type: VifCodeType.UNPACK,
				data: position_dv.buffer,
				interrupt: false,
				location,
				masked: false,
				num: part_indices.length,
				unsigned: false,
				use_tops: true,
				vl: 0,
				vn: 2
			});
			vif_code.push({
				type: VifCodeType.UNPACK,
				data: new Uint8Array(kick_flags).buffer,
				interrupt: false,
				location,
				masked: true,
				num: part_indices.length,
				unsigned: false,
				use_tops: true,
				vl: 2,
				vn: 0
			});
			location += part_indices.length;

			let one_level = ntdf_material.passes[0].shader_type == ShaderType.Unlit ? 0x80 : 0x10;
			let color_multiplier = ntdf_material.texture_file >= 0 ? 1 : 2;

			let color_arr = new Uint8Array(part_indices.length*4);
			for(let i = 0; i < part_indices.length; i++) {
				let r=1,g=1,b=1,a=1;
				if(colors) {
					let ci = part_indices[i]*(has_alpha?4:3);
					r = linear_to_srgb(colors[ci]);
					g = linear_to_srgb(colors[ci+1]);
					b = linear_to_srgb(colors[ci+2]);
					if(has_alpha) a = colors[ci+3];
				}

				color_arr[i*4] = Math.min(255, Math.max(0, r * one_level * color_multiplier));
				color_arr[i*4+1] = Math.min(255, Math.max(0, g * one_level * color_multiplier));
				color_arr[i*4+2] = Math.min(255, Math.max(0, b * one_level * color_multiplier));
				color_arr[i*4+3] = Math.min(255, Math.max(0, a * one_level));
			}
			vif_code.push({
				type: VifCodeType.UNPACK,
				data: color_arr.buffer,
				interrupt: false,
				location,
				masked: false,
				num: part_indices.length,
				unsigned: true,
				use_tops: true,
				vl: 2,
				vn: 3
			});
			location += part_indices.length;

			if(shader_type != ShaderType.Unlit) {
				assert(normals);
				let normals_dv = new DataView(new ArrayBuffer(part_indices.length*12));
				for(let i = 0; i < part_indices.length; i++) {
					let norm : Vec3 = [normals[part_indices[i]*3], normals[part_indices[i]*3+1], normals[part_indices[i]*3+2]];
					norm = apply_matrix(transform, norm, false);
					normals_dv.setFloat32(i*12, norm[0], true);
					normals_dv.setFloat32(i*12+4, norm[1], true);
					normals_dv.setFloat32(i*12+8, norm[2], true);
				}
				vif_code.push({
					type: VifCodeType.UNPACK,
					data: normals_dv.buffer,
					interrupt: false,
					location,
					masked: false,
					num: part_indices.length,
					unsigned: false,
					use_tops: true,
					vl: 0,
					vn: 2
				});
				location += part_indices.length;
			}

			if(ntdf_material.texture_file >= 0) {
				let uv_dv = new DataView(new ArrayBuffer(part_indices.length*8*ntdf_material.passes.length));
				for(let i = 0; i < ntdf_material.passes.length; i++) {
					let texcoords_arr = texcoords[Math.min(i, texcoords.length-1)];
					let this_off = part_indices.length*i*8;
					for(let j = 0; j < part_indices.length; j++) {
						let u=0,v=0;
						if(texcoords_arr) {
							u = texcoords_arr[part_indices[j]*2];
							v = texcoords_arr[part_indices[j]*2+1];
						}
						uv_dv.setFloat32(this_off+j*8, u, true);
						uv_dv.setFloat32(this_off+j*8+4, v, true);
					}
				}
				vif_code.push({
					type: VifCodeType.UNPACK,
					data: uv_dv.buffer,
					interrupt: false,
					location,
					masked: false,
					num: part_indices.length*ntdf_material.passes.length,
					unsigned: false,
					use_tops: true,
					vl: 0,
					vn: 1
				});
				location += part_indices.length*ntdf_material.passes.length;
			}
		}
		let node : ModelNodeMesh = {
			type: ModelNodeType.Mesh,
			bounds_origin: bound_start,
			bounds_size: [
				bound_end[0]-bound_start[0],
				bound_end[1]-bound_start[1],
				bound_end[2]-bound_start[2]
			],
			center,
			children: [],
			id: this.id_ctr++,
			initial_state: initial_state.buffer,
			material: ntdf_material_index,
			radius: Math.sqrt(radius_sq),
			vif_code
		};
		return [node];
	}

	dedupe_indices(primitive : MeshPrimitive, indices : number[]) {
		let vert_map = new Map<string, number>();
		let accessors = this.gltf.accessors;
		assert(accessors);
		let num_vertices = accessors[primitive.attributes.POSITION].count;
		let datas : number[][] = [];
		let material = this.materials.materials[this.get_ntdf_material_index(primitive)];
		for(let [name, item] of Object.entries(primitive.attributes)) {
			if(name == "TEXCOORD_1" && material.passes.length < 2) continue;
			if(name.startsWith("TEXCOORD_") && material.texture_file < 0) continue;
			if(name == "NORMAL" && material.passes[0].shader_type == ShaderType.Unlit) continue;
			let data = this.get_accessor(item).data;
			datas.push(data);
		}
		let index_map : number[] = [];
		for(let i = 0; i < num_vertices; i++) {
			let key_parts : string[] = [];
			for(let data of datas) {
				let vecness = data.length / num_vertices;
				for(let j = 0; j < vecness; j++) {
					key_parts.push(data[vecness*i+j].toFixed(4));
				}
			}
			let key = key_parts.join(",");
			let existing = vert_map.get(key);
			if(existing != undefined) index_map.push(existing);
			else {
				vert_map.set(key, i);
				index_map.push(i);
			}
		}
		return indices.map(i => {
			return index_map[i];
		});
	}

	total_strip_length = 0;
	total_strips = 0;

	stripify_primitive(primitive : MeshPrimitive, max_verts_per_strip = Infinity) : number[][] {
		assert(primitive.indices != undefined);

		let indices : number[] = this.dedupe_indices(primitive, this.get_accessor(primitive.indices).data);
		let triangles : [number,number,number][] = [];
		if(primitive.mode == 6) {
			for(let i = 2; i < indices.length; i++) {
				triangles.push([indices[0], indices[i-1], indices[i]]);
			}
		} else if(primitive.mode == 5) {
			for(let i = 2; i < indices.length; i++) {
				triangles.push([indices[i-2], indices[i-1], indices[i]]);
			}
		} else {
			for(let i = 0; i < indices.length; i += 3) {
				triangles.push([indices[i], indices[i+1], indices[i+2]]);
			}
		}
		let max_index = 0;
		for(let index of indices) max_index = Math.max(max_index, index+1);
		let unincluded_triangles = new Set<number>();
		let index_triangles : number[][] = [];
		for(let i = 0; i < max_index; i++) index_triangles.push([]);
		for(let i = 0; i < triangles.length; i++) {
			let tri = triangles[i];
			if(tri[0] == tri[1] || tri[0] == tri[2] || tri[1] == tri[2]) {
				triangles.splice(i, 1);
				i--;
				continue;
			}
			unincluded_triangles.add(i);
			index_triangles[tri[0]].push(i);
			index_triangles[tri[1]].push(i);
			index_triangles[tri[2]].push(i);
		}
		
		let strips : number[][] = [];
		let next_triangle : number|undefined = undefined;
		while(unincluded_triangles.size) {
			let this_triangle : number;
			if(next_triangle == undefined) {
				for(let triangle of unincluded_triangles) {
					next_triangle = triangle; break;
				}
			}
			if(next_triangle != undefined) {
				this_triangle = next_triangle;
				next_triangle = undefined;
			} else {
				break;
			}

			unincluded_triangles.delete(this_triangle);

			let tri = triangles[this_triangle];
			let dir = 0;
			for(let i = 0; i < 3; i++) {
				let a = tri[(i+1)%3];
				let b = tri[(i+2)%3];
				let c = tri[i];
				let success = false;
				for(let triangle2 of index_triangles[a]) {
					if(!unincluded_triangles.has(triangle2)) continue;
					let tri2 = triangles[triangle2];
					if(tri2.includes(a) && tri2.includes(b) && !tri2.includes(c)) {
						success = true; break;
					}
				}
				if(success){ 
					dir = i; break;
				}
			}

			let strip = [tri[dir],tri[(dir+1)%3],tri[(dir+2)%3]]
			while(strip.length < max_verts_per_strip && unincluded_triangles.size) {
				let a = strip[strip.length-1];
				let b = strip[strip.length-2];
				let c = strip[strip.length-3];
				let next : [number,number,number]|undefined;
				for(let triangle2 of index_triangles[a]) {
					if(!unincluded_triangles.has(triangle2)) continue;
					let tri2 = triangles[triangle2];
					if(tri2.includes(a) && tri2.includes(b) && !tri2.includes(c)) {
						unincluded_triangles.delete(triangle2);
						next = tri2; break;
					}
				}
				if(!next) break;
				if(next[0] != a && next[0] != b) strip.push(next[0]);
				else if(next[1] != a && next[1] != b) strip.push(next[1]);
				else if(next[2] != a && next[2] != b) strip.push(next[2]);
				else throw new Error("Stripification error");
			}
			let backward_strip = [strip[2],strip[1],strip[0]];
			// Work backwards
			while((strip.length+backward_strip.length-3) < max_verts_per_strip && unincluded_triangles.size) {
				let a = backward_strip[backward_strip.length-1];
				let b = backward_strip[backward_strip.length-2];
				let c = backward_strip[backward_strip.length-3];
				let next : [number,number,number]|undefined;
				for(let triangle2 of index_triangles[a]) {
					if(!unincluded_triangles.has(triangle2)) continue;
					let tri2 = triangles[triangle2];
					if(tri2.includes(a) && tri2.includes(b) && !tri2.includes(c)) {
						unincluded_triangles.delete(triangle2);
						next = tri2; break;
					}
				}
				if(!next) break;
				if(next[0] != a && next[0] != b) backward_strip.push(next[0]);
				else if(next[1] != a && next[1] != b) backward_strip.push(next[1]);
				else if(next[2] != a && next[2] != b) backward_strip.push(next[2]);
				else throw new Error("Stripification error");
			}
			backward_strip.reverse();
			backward_strip.length -= 3;
			if(backward_strip.length > 0) strip.splice(0, 0, ...backward_strip);
			strips.push(strip);
			let last_index = strip[strip.length-1];
			for(let triangle2 of index_triangles[last_index]) {
				if(!unincluded_triangles.has(triangle2)) continue;
				let tri2 = triangles[triangle2];
				if(tri2.includes(last_index)) {
					next_triangle = triangle2; break;
				}
			}
			this.total_strip_length += strip.length;
			this.total_strips++;
		}
		return strips;
	}
	
	get_accessor(id : number) {
		let accessors = this.gltf.accessors;
		assert(accessors);
		let accessor = accessors[id];
		let buffer_views = this.gltf.bufferViews;
		assert(buffer_views);
		assert(accessor.bufferView != undefined);
		let view = buffer_views[accessor.bufferView];
		assert(view.byteOffset != undefined);

		let numbers = [];
		let amount_numbers = accessor.count;
		if(accessor.type == "VEC2") amount_numbers *= 2;
		else if(accessor.type == "VEC3") amount_numbers *= 3;
		else if(accessor.type == "VEC4") amount_numbers *= 4;


		let ptr = this.binary_offset + view.byteOffset + (accessor.byteOffset??0);
		if(accessor.componentType == 5120) {
			if(accessor.normalized) {
				for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getInt8(ptr + i) / 127);
			} else {
				for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getInt8(ptr + i));
			}
		} else if(accessor.componentType == 5121) {
			if(accessor.normalized) {
				for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getUint8(ptr + i) / 255);
			} else {
				for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getUint8(ptr + i));
			}
		} else if(accessor.componentType == 5122) {
			if(accessor.normalized) {
				for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getInt16(ptr + i*2, true) / 32767);
			} else {
				for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getInt16(ptr + i*2, true));
			}
		} else if(accessor.componentType == 5123) {
			if(accessor.normalized) {
				for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getUint16(ptr + i*2, true) / 65535);
			} else {
				for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getUint16(ptr + i*2, true));
			}
		} else if(accessor.componentType == 5125) {
			for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getUint32(ptr + i*4, true));
		} else if(accessor.componentType == 5126) {
			for(let i = 0; i < amount_numbers; i++) numbers.push(this.glb_dv.getFloat32(ptr + i*4, true));
		}

		return {
			byteOffset: ptr,
			componentType: accessor.componentType,
			count: accessor.count,
			type: accessor.type,
			data: numbers
		}
	}

	get_ntdf_material_index(primitive : MeshPrimitive) : number {
		let all_materials = this.gltf.materials;
		if(!all_materials) return 0;
		if(!primitive.material) return 0;
		let material = all_materials[primitive.material];
		assert(material, "Primitive references non-extistent material " + primitive.material);
		let material_index:number = material.extras?.ntdf_mat_index;
		if(material_index != undefined) {
			assert(this.materials.materials[material_index], "glTF file references non-existent material index " + material_index + " in material " + material.name);
			return material_index;
		}
		return 0;
	}

	absolute_transforms = new Map<Node, Matrix>();

	propogate_transform(node : Node, transform : Matrix = identity_matrix, zone_holder = this.get_zone_holder(0), lod_group = zone_holder.main_lod_group) {
		transform = matrix_multiply(transform, (node.matrix as Matrix|undefined) ?? transform_to_matrix(node.translation as Vec3|undefined, node.rotation as Vec4|undefined, node.scale as Vec3|undefined));
		this.absolute_transforms.set(node, transform);
		if(node.extras?.zone_id != undefined && node.extras?.zone_id != zone_holder.zone_id) {
			let zone_id = node.extras.zone_id|0;
			assert(zone_id >= 0 && zone_id < 256, "Zone id " + zone_id + " is out of range");
			zone_holder = this.get_zone_holder(zone_id);
			lod_group = zone_holder.main_lod_group;
		}
		if(node.extras?.render_distance || (node.extras?.display_mask != undefined && node.extras?.display_mask != lod_group.display_mask)) {
			let old = lod_group;
			lod_group = {
				nodes: [],
				fade_rate: node.extras?.fade_rate ?? 0,
				display_mask: node.extras?.display_mask ?? old.display_mask,
				render_distance: node.extras?.render_distance ?? old.render_distance
			};
			zone_holder.lod_groups.push(lod_group);
		}
		lod_group.nodes.push(node);
		if(node.children) {
			for(let child of node.children) {
				this.propogate_transform(this.all_nodes[child], transform, zone_holder, lod_group);
			}
		}
	}

	zone_holders : Array<ZoneHolder|undefined> = [];
	get_zone_holder(zone_id : number) : ZoneHolder {
		let holder = this.zone_holders[zone_id];
		if(holder) return holder;
		let main_lod_group : LodGroupHolder = {
			nodes: [],
			fade_rate: 0,
			display_mask: 0,
			render_distance: 10000
		};
		return this.zone_holders[zone_id] = {
			main_lod_group,
			lod_groups: [main_lod_group],
			zone_id
		};
	}
}

interface ZoneHolder {
	main_lod_group : LodGroupHolder;
	lod_groups : LodGroupHolder[];
	zone_id : number;
}

interface LodGroupHolder {
	nodes : Node[];
	fade_rate : number;
	display_mask : number;
	render_distance : number;
}
