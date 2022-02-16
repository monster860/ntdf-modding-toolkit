import Blob from "cross-blob";

export interface Light {
	position : [number,number,number];
	direction : [number,number,number];
	color : [number,number,number];
	type : LightType;
	intensity : number;
	range : number;
	zone_id : number;
}
export interface LightGroup {
	base_lights? : Light[];
	lights? : Light[];
	base_ambient_light? : Light
}
export enum LightType {
	Ambient = 1,
	Directional = 2,
	Point = 3
};

export class LightsChunk {
	constructor(public groups : LightGroup[]) {};

	static async from_blob(blob : Blob) {
		let dv = new DataView(await blob.arrayBuffer());
		let num_instances = dv.getUint32(0, true);
		let curr_ptr = dv.getUint32(4, true) + Math.ceil(num_instances/4)*16;
		let groups : LightGroup[] = [];
		for(let i = 0; i < num_instances; i++) {
			//let a = dv.getUint16(curr_ptr, true);
			//let b = dv.getUint16(curr_ptr+2, true);
			let amt_base = dv.getUint16(curr_ptr+4, true);
			let amt_lights = dv.getUint16(curr_ptr+6, true);
			let amt_base_ambient = dv.getUint16(curr_ptr+8, true);
			curr_ptr += 0x20;

			let base_lights : Light[] = [];
			let lights : Light[] = [];
			let base_ambient_light : Light|undefined = undefined;
			for(let i = 0; i < amt_base; i++) {
				base_lights.push(LightsChunk.decode_light(dv, curr_ptr));
				curr_ptr += 0x50;
			}
			for(let i = 0; i < amt_lights; i++) {
				lights.push(LightsChunk.decode_light(dv, curr_ptr));
				curr_ptr += 0x50;
			}
			for(let i = 0; i < amt_base_ambient; i++) {
				base_ambient_light = LightsChunk.decode_light(dv, curr_ptr);
				curr_ptr += 0x50;
			}
			groups.push({base_lights, lights, base_ambient_light});
		}
		return new LightsChunk(groups);
	}

	private static decode_light(dv : DataView, offset : number) : Light {
		let position : [number,number,number] = [
			dv.getFloat32(offset+0x0, true),
			dv.getFloat32(offset+0x4, true),
			dv.getFloat32(offset+0x8, true)
		];
		let direction : [number,number,number] = [
			dv.getFloat32(offset+0x10, true),
			dv.getFloat32(offset+0x14, true),
			dv.getFloat32(offset+0x18, true)
		];
		let color : [number,number,number] = [
			dv.getFloat32(offset+0x20, true),
			dv.getFloat32(offset+0x24, true),
			dv.getFloat32(offset+0x28, true)
		];
		let type = dv.getUint32(offset + 0x30, true);
		let intensity = dv.getFloat32(offset + 0x34, true);
		let range = dv.getFloat32(offset+0x3c, true);
		let zone_id = dv.getUint32(offset + 0x44, true);
		return {
			position, direction, color,
			type, intensity, range, zone_id
		};
	}

	private encode_light(dv : DataView, offset : number, light : Light) {
		dv.setFloat32(offset+0x0, light.position[0], true);
		dv.setFloat32(offset+0x4, light.position[1], true);
		dv.setFloat32(offset+0x8, light.position[2], true);

		dv.setFloat32(offset+0x10, light.direction[0], true);
		dv.setFloat32(offset+0x14, light.direction[1], true);
		dv.setFloat32(offset+0x18, light.direction[2], true);

		dv.setFloat32(offset+0x20, light.color[0], true);
		dv.setFloat32(offset+0x24, light.color[1], true);
		dv.setFloat32(offset+0x28, light.color[2], true);

		dv.setUint32(offset + 0x30, light.type, true);
		dv.setFloat32(offset + 0x34, light.intensity, true);
		dv.setFloat32(offset + 0x3c, light.range, true);
		dv.setFloat32(offset + 0x40, light.range >= 0 ? light.range**2 : -1, true);
		dv.setFloat32(offset + 0x44, light.zone_id, true);
	}

	copy() {
		return new LightsChunk(JSON.parse(JSON.stringify(this.groups)));
	}
}