import { Chunk } from "../gamefile/chunk_file.js";
import { Matrix } from "../utils/misc.js";
import Blob from "cross-blob";

export interface InstancedModel {
	model : Chunk;
	lod_model : Chunk|undefined;
	instances : ModelInstance[];
	render_distance : number;
	lod_distance : number;
	fade_depth : number;
}
export interface ModelInstance {
	transform : Matrix;
	zone_id : number;
}

export class InstancedModelsChunk {
	constructor(public models : InstancedModel[]) {}
	static async from_blob(blob : Blob) {
		let header_dv = new DataView(await blob.slice(0, 8).arrayBuffer());
		let num_entries = header_dv.getUint32(0, true);
		let entries_ptr = header_dv.getUint32(4, true);
		let entries_dv = new DataView(await blob.slice(entries_ptr, entries_ptr + num_entries*4).arrayBuffer());

		let models : InstancedModel[] = [];

		for(let i = 0; i < num_entries; i++) {
			let entry_ptr = entries_dv.getUint32(i*4, true);
			let entry_dv = new DataView(await blob.slice(entry_ptr, entry_ptr + 0x30).arrayBuffer());
			let model = await Chunk.from_blob(blob.slice(entry_ptr + entry_dv.getUint32(0x10, true)));
			let lod_model_offset = entry_dv.getUint32(0x14, true);
			let lod_model = lod_model_offset ? await Chunk.from_blob(blob.slice(entry_ptr + lod_model_offset)) : undefined;

			let render_distance = entry_dv.getFloat32(0x1c, true);
			let lod_distance = entry_dv.getFloat32(0x20, true);
			let fade_depth = entry_dv.getFloat32(0x18, true);
			
			let instances_ptr = entry_ptr + entry_dv.getUint32(0x2c, true);
			let num_instances = entry_dv.getUint32(0x28, true);
			let instances_dv = new DataView(await blob.slice(instances_ptr, instances_ptr+num_instances*0x50).arrayBuffer());

			let instances : ModelInstance[] = [];
			for(let j = 0; j < num_instances; j++) {
				let transform:Matrix = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
				for(let k = 0; k < 16; k++) {
					transform[k] = instances_dv.getFloat32(j*0x50 + k*0x4, true);
				}
				let zone_id = instances_dv.getUint8(j*0x50 + 0x40);
				instances.push({transform, zone_id});
			}
			models.push({model, instances, lod_model, render_distance, lod_distance, fade_depth});
		}
		return new InstancedModelsChunk(models);
	}

	to_blob() : Blob {
		let parts : BlobPart[] = [];

		let header_dv = new DataView(new ArrayBuffer(0x10 + Math.ceil(this.models.length) * 0x10));
		header_dv.setUint32(0, this.models.length, true);
		header_dv.setUint32(4, 0x10, true);
		parts.push(header_dv.buffer);
		let total_len = header_dv.byteLength;
		for(let [entry_index, entry] of this.models.entries()) {
			header_dv.setUint32(0x10 + 0x4*entry_index, total_len, true);
			let entry_dv = new DataView(new ArrayBuffer(0x30));
			parts.push(entry_dv.buffer);
			let entry_len = entry_dv.byteLength;

			entry_dv.setFloat32(0x1c, entry.render_distance, true);
			entry_dv.setFloat32(0x20, entry.lod_distance, true);
			entry_dv.setFloat32(0x18, entry.fade_depth, true);

			entry_dv.setUint32(0x10, entry_len, true);
			let model_blob = entry.model.to_blob(entry_len + total_len);
			parts.push(model_blob);
			entry_len += model_blob.size;

			if(entry.lod_model) {
				entry_dv.setUint32(0x14, entry_len, true);
				let lod_model_blob = entry.lod_model.to_blob(entry_len + total_len);
				parts.push(lod_model_blob);
				entry_len += lod_model_blob.size;
			}
			if(entry_len & 0xF) {
				let padding = 0x10 - (entry_len & 0xF);
				entry_len += padding;
				parts.push(new ArrayBuffer(padding));
			}

			entry_dv.setUint32(0x28, entry.instances.length, true);
			entry_dv.setUint32(0x2c, entry_len, true);
			let instances_dv = new DataView(new ArrayBuffer(0x50 * entry.instances.length));
			entry_len += instances_dv.byteLength;
			parts.push(instances_dv.buffer);

			for(let i = 0; i < entry.instances.length; i++) {
				let instance = entry.instances[i];
				for(let j = 0; j < 16; j++) {
					instances_dv.setFloat32(0x50*i+j*4, instance.transform[j], true);
				}
				instances_dv.setUint8(0x50*i+0x40, instance.zone_id);
			}

			total_len += entry_len;
		}

		return new Blob(parts);
	}

	copy() {
		return new InstancedModelsChunk([...this.models]);
	}
}