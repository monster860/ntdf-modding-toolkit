import { decode_adpcm, encode_adpcm } from "../ps2/adpcm.js";
import Blob from "cross-blob";

export class VagAudio {
	constructor(
		public name : string,
		public data : Float32Array,
		public sample_rate : number = 22050,
	) {}

	static async get_name(blob : Blob) : Promise<string> {
		let sliced = new Uint8Array(await blob.slice(0, 0x30).arrayBuffer());
		let sliced_dv = new DataView(sliced.buffer);
		if(sliced_dv.getUint32(0, false) != 0x56414770) {
			throw new Error("Not VAG audio");
		}
		let name = new TextDecoder('utf8').decode(sliced.subarray(0x20, 0x2F));
		let name_end = name.indexOf("\0");
		if(name_end >= 0) name = name.substring(0, name_end);
		return name;
	}

	static async from_blob(blob : Blob) : Promise<VagAudio> {
		let data = new Uint8Array(await blob.arrayBuffer());
		let data_dv = new DataView(data.buffer);
		if(data_dv.getUint32(0, false) != 0x56414770) {
			throw new Error("Not VAG audio");
		}
		let name = new TextDecoder('utf8').decode(data.subarray(0x20));
		let name_end = name.indexOf("\0");
		if(name_end >= 0) name = name.substring(0, name_end);
		let length = data_dv.getUint32(0x0C, false);
		let sample_rate = data_dv.getUint32(0x10, false);
		console.log(length);
		let {float_data} = decode_adpcm(data.subarray(0x40, 0x30+length));
		return new VagAudio(name, float_data, sample_rate);
	}

	to_blob() : Blob {
		let adpcm = encode_adpcm(this.data);
		let data = new Uint8Array(0x40 + adpcm.length);
		data.set(adpcm, 0x40);
		data.set(new TextEncoder().encode(this.name).subarray(0, 15), 0x20);
		let dv = new DataView(data.buffer);
		dv.setUint32(0x0, 0x56414770, false);
		dv.setUint32(0x4, 0x20, false);
		dv.setUint32(0xC, adpcm.length + 16, false);
		dv.setUint32(0x10, this.sample_rate, false);
		return new Blob([data]);
	}
}
