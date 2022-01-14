import Blob from "cross-blob"
import { decode_text, encode_text } from "../utils/text.js";

export class HeaderChunk {
	constructor(
		public description = "IdolWorld",
		public major_version = 2,
		public minor_version = 1
	) {}

	async from_blob(blob : Blob) : Promise<HeaderChunk> {
		let dv = new DataView(await blob.arrayBuffer());
		let major_version = dv.getUint32(0, true);
		let minor_version = dv.getUint32(4, true);
		let description = decode_text(new Uint8Array(dv.buffer, 8));
		return new HeaderChunk(description, major_version, minor_version);
	}

	to_blob() : Blob {
		let text = encode_text(this.description);
		let data = new Uint8Array(Math.ceil((text.length + 9) / 16) * 16);
		let dv = new DataView(data.buffer);
		dv.setUint32(0, this.major_version, true);
		dv.setUint32(4, this.minor_version, true);
		data.set(text, 8);
		return new Blob([dv.buffer]);
	}
}