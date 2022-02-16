import { read_vif_code, VifCode, VifCodeType, write_vif_code } from "../ps2/vifcode.js";
import assert from "assert";
import Blob from 'cross-blob';

export enum ModelNodeType {
	Empty = 0,
	Mesh = 1,
	ZoneGroup = 3,
	LodGroup = 4,
}
export interface BufferList {
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

interface ModelNodeBase {
	type : ModelNodeType;
	id : number;

	children : ModelNode[];

	bounds_origin : [number,number,number];
	bounds_size : [number,number,number];
	center : [number,number,number];

	addr? : number;

	radius : number;
	render_distance? : number;
}

export interface ModelNodeMesh extends ModelNodeBase {
	type : ModelNodeType.Mesh;
	material : number;

	initial_state : ArrayBuffer;
	vif_code : VifCode[];
}

export interface ModelNodeLodGroup extends ModelNodeBase {
	type : ModelNodeType.LodGroup
	c1 : ModelNode|null;
	c2 : ModelNode|null;
	c3 : ModelNode|null;
	fade_rate: number;
	render_distance : number;
	display_mask : number;
	sort_order : number;
}

export interface ModelNodeZoneGroup extends ModelNodeBase {
	type : ModelNodeType.ZoneGroup;
	zone_id : number;
}

export interface ModelNodeEmpty extends ModelNodeBase {
	type : ModelNodeType.Empty
}

export type ModelNode = ModelNodeMesh|ModelNodeLodGroup|ModelNodeEmpty|ModelNodeZoneGroup;

export class ModelChunk {
	constructor(public root : ModelNode = {
		type: ModelNodeType.Empty,
		bounds_origin: [0,0,0],
		bounds_size: [0,0,0],
		center: [0,0,0],
		children: [],
		id: 0,
		radius: 0
	}) {
	}

	to_blob() : Blob {
		let allocations : ModelAllocations = {
			curr_length: 0,
			dupe_check: new Set(),
			mesh_vifcodes: new Map()
		};
		this.allocate_node(this.root, allocations);
		let buf = new ArrayBuffer(allocations.curr_length);
		this.write_node(new DataView(buf), this.root, allocations);

		return new Blob([buf]);
	}

	static get_mesh_buffers(node : ModelNodeMesh) {
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
				} else if(which == 2 && item.vn == 2 && item.vl == 0) {
					buffer_list.normals = item.data;
				} else if(item.vn == 1 && item.vl == 0) {
					if(size == 2) {
						buffer_list.uv = item.data.slice(0, 8*buffer_list.num_vertices);
						buffer_list.uv2 = item.data.slice(8*buffer_list.num_vertices, 16*buffer_list.num_vertices);
					} else {
						buffer_list.uv = item.data;
					}
				} else if(which == 3 && item.vn == 2 && item.vl == 0) {
					buffer_list.weights = item.data;
				} else if(which == 4 && item.vn == 3 && item.vl == 2) {
					buffer_list.joints = item.data;
				}
			} else if(item.type == VifCodeType.MSCNT) {
				buffer_lists.push({...buffer_list});
				buffer_list.vertex_start += buffer_list.num_vertices;
			}
		}
		buffer_lists.push({...buffer_list});
		buffer_list.vertex_start += buffer_list.num_vertices;
		return [buffer_lists, buffer_list.vertex_start] as const;
	}

	private allocate_node(node : ModelNode, allocations : ModelAllocations) {
		assert(!allocations.dupe_check.has(node));
		allocations.dupe_check.add(node);

		node.addr = allocations.curr_length;
		if(node.type == ModelNodeType.Empty) {
			allocations.curr_length += 0x50;
		} else if(node.type == ModelNodeType.ZoneGroup) {
			allocations.curr_length += 0x60;
		} else if(node.type == ModelNodeType.LodGroup) {
			allocations.curr_length += 0x80;
			if(node.c1) this.allocate_node(node.c1, allocations);
			if(node.c2) this.allocate_node(node.c2, allocations);
			if(node.c3) this.allocate_node(node.c3, allocations);
		} else if(node.type == ModelNodeType.Mesh) {
			allocations.curr_length += 0x90;
			allocations.curr_length += node.initial_state.byteLength;
			let vif_code_enc = write_vif_code(node.vif_code);
			allocations.curr_length = Math.ceil((allocations.curr_length + vif_code_enc.byteLength) / 16) * 16;
			allocations.mesh_vifcodes.set(node, vif_code_enc);
		} else {
			throw new Error("unknown node type " + (node as any).type);
		}
		for(let child of node.children) {
			this.allocate_node(child, allocations);
		}
	}

	private write_node(dv : DataView, node : ModelNode, allocations : ModelAllocations) {
		let ptr = node.addr;
		assert(ptr != undefined);
		dv.setUint32(ptr, node.type, true);
		dv.setFloat32(ptr+4, (node.render_distance ?? 10000)**2, true);
		dv.setFloat32(ptr+8, node.radius, true);

		dv.setFloat32(ptr+0x10, node.bounds_origin[0], true);
		dv.setFloat32(ptr+0x14, node.bounds_origin[1], true);
		dv.setFloat32(ptr+0x18, node.bounds_origin[2], true);

		dv.setFloat32(ptr+0x20, node.bounds_size[0], true);
		dv.setFloat32(ptr+0x24, node.bounds_size[1], true);
		dv.setFloat32(ptr+0x28, node.bounds_size[2], true);
		dv.setFloat32(ptr+0x2C, 1, true);

		dv.setFloat32(ptr+0x30, node.center[0], true);
		dv.setFloat32(ptr+0x34, node.center[1], true);
		dv.setFloat32(ptr+0x38, node.center[2], true);
		dv.setFloat32(ptr+0x3C, node.radius**2, true);

		let child_write_ptr = ptr+0x40;
		for(let child of node.children) {
			assert(child.addr);
			this.write_node(dv, child, allocations);
			dv.setUint32(child.addr + 0x48, ptr, true);
			dv.setUint32(child_write_ptr, child.addr, true);
			child_write_ptr = child.addr + 0x44;
		}
		dv.setUint32(ptr+0x4c, node.id, true);
		if(node.type == ModelNodeType.ZoneGroup) {
			dv.setUint8(ptr + 0x50, node.zone_id);
		} else if(node.type == ModelNodeType.LodGroup) {
			if(node.c1) {
				assert(node.c1.addr);
				this.write_node(dv, node.c1, allocations);
				dv.setUint32(node.c1.addr + 0x48, ptr, true);
				dv.setUint32(ptr + 0x70, node.c1.addr, true);
			}
			if(node.c2) {
				assert(node.c2.addr);
				this.write_node(dv, node.c2, allocations);
				dv.setUint32(node.c2.addr + 0x48, ptr, true);
				dv.setUint32(ptr + 0x74, node.c2.addr, true);
			}
			if(node.c3) {
				assert(node.c3.addr);
				this.write_node(dv, node.c3, allocations);
				dv.setUint32(node.c3.addr + 0x48, ptr, true);
				dv.setUint32(ptr + 0x78, node.c3.addr, true);
			}
			dv.setFloat32(ptr + 0x58, node.fade_rate, true);
			dv.setUint32(ptr + 0x5C, node.display_mask, true);
			dv.setFloat32(ptr + 0x64, node.render_distance, true);
			dv.setInt8(ptr + 0x62, node.sort_order);
		} else if(node.type == ModelNodeType.Mesh) {
			let arr = new Uint8Array(dv.buffer);
			arr.set(new Uint8Array(node.initial_state), ptr+0x90);
			let vifcode_buf = allocations.mesh_vifcodes.get(node);
			assert(vifcode_buf);
			arr.set(new Uint8Array(vifcode_buf), ptr+0x90+node.initial_state.byteLength);

			dv.setUint16(ptr + 0x92, Math.ceil((vifcode_buf.byteLength + node.initial_state.byteLength) / 16), true);

			dv.setUint32(ptr + 0x50, ptr + 0x90, true);
			dv.setUint32(ptr + 0x5C, node.material, true);
		}
	}

	static async from_blob(blob : Blob) : Promise<ModelChunk> {
		let dv = new DataView(await blob.arrayBuffer());
		return new ModelChunk(ModelChunk.read_node(dv, 0));
	}

	private static read_node(dv : DataView, ptr : number) : ModelNode {
		let type : ModelNodeType = dv.getUint32(ptr, true);
		let id = dv.getUint32(ptr + 0x4C, true);

		let children : ModelNode[] = [];
		let child_ptr = dv.getUint32(ptr + 0x40, true);
		while(child_ptr) {
			children.push(ModelChunk.read_node(dv, child_ptr));
			child_ptr = dv.getUint32(child_ptr + 0x44, true);
		}

		let radius = dv.getFloat32(ptr + 0x8, true);
		let render_distance = Math.sqrt(dv.getFloat32(ptr + 0x4, true));

		let bounds_origin : [number,number,number] = [
			dv.getFloat32(ptr + 0x10, true),
			dv.getFloat32(ptr + 0x14, true),
			dv.getFloat32(ptr + 0x18, true),
		];
		let bounds_size : [number,number,number] = [
			dv.getFloat32(ptr + 0x20, true),
			dv.getFloat32(ptr + 0x24, true),
			dv.getFloat32(ptr + 0x28, true),
		];
		let center : [number,number,number] = [
			dv.getFloat32(ptr + 0x30, true),
			dv.getFloat32(ptr + 0x34, true),
			dv.getFloat32(ptr + 0x38, true),
		];
		if(type == ModelNodeType.LodGroup) {
			let c1_ptr = dv.getUint32(ptr + 0x70, true);
			let c2_ptr = dv.getUint32(ptr + 0x74, true);
			let c3_ptr = dv.getUint32(ptr + 0x78, true);
			let c1 = c1_ptr ? ModelChunk.read_node(dv, c1_ptr) : null;
			let c2 = c2_ptr ? ModelChunk.read_node(dv, c2_ptr) : null;
			let c3 = c3_ptr ? ModelChunk.read_node(dv, c3_ptr) : null;
			let fade_rate = dv.getFloat32(ptr + 0x58, true);
			let display_mask = dv.getUint32(ptr + 0x5C, true);
			let sort_order = dv.getInt8(ptr + 0x62)
			return {
				type, id, children,
				bounds_origin, bounds_size, center,
				radius, render_distance,
				fade_rate,
				sort_order,
				c1, c2, c3,
				display_mask,
				addr: ptr
			};
		} else if(type == ModelNodeType.Mesh) {
			let data_ptr = dv.getUint32(ptr + 0x50, true);
			let material = dv.getUint16(ptr + 0x5C, true);

			let data_size = dv.getUint16(data_ptr + 2, true);
			let initial_size = dv.getUint8(data_ptr + 0xC);
			let initial_state = dv.buffer.slice(dv.byteOffset + data_ptr, dv.byteOffset + data_ptr + initial_size*0x10);

			let vif_code = read_vif_code(dv, data_ptr + initial_size * 0x10, (data_size - initial_size) * 0x10);
			return {
				type, id, children,
				bounds_origin, bounds_size, center,
				radius, render_distance,
				material, initial_state, vif_code,
				addr: ptr
			};
		} else if(type == ModelNodeType.ZoneGroup) {
			let zone_id = dv.getUint8(ptr + 0x50);
			return {
				type, id, children,
				bounds_origin, bounds_size, center,
				radius, render_distance,
				zone_id,
				addr: ptr
			};
		} {
			return {
				type, id, children,
				bounds_origin, bounds_size, center,
				radius, render_distance,
				addr: ptr
			};
		}
	}
}

interface ModelAllocations {
	curr_length : number;
	mesh_vifcodes : Map<ModelNodeMesh, ArrayBuffer>;
	dupe_check : Set<ModelNode>;
}
