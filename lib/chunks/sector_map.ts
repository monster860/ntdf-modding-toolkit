import { SectorMap } from "../gamefile/sector_map";
import Blob from "cross-blob";

export class SectorMapChunk implements SectorMap {
	constructor(
		public name : string,
		public sectors : number[],
		public sizes : number[]
	) {}

	static async from_blob(blob : Blob) : Promise<SectorMapChunk> {
		let dv = new DataView(await blob.arrayBuffer());
		let name = new TextDecoder('utf8').decode(new Uint8Array(dv.buffer, 0, 0xFF));
		let name_end = name.indexOf('\0');
		if(name_end >= 0) {
			name = name.substring(0, name_end);
		}
		let sectors : number[] = [];
		let sizes : number[] = [];
		let amount = dv.getUint32(0x100, true);
		for(let i = 0; i < amount; i++) {
			sectors.push(dv.getUint32(0x104 + i*8, true));
			sizes.push(dv.getUint32(0x108 + i*8, true));
		}
		return new SectorMapChunk(name, sectors, sizes);
	}

	to_blob() : Blob {
		let dv = new DataView(new ArrayBuffer(0x104 + this.sectors.length*8));

		new Uint8Array(dv.buffer, 0, 0xFF).set(new TextEncoder().encode(this.name));

		dv.setUint32(0x100, this.sectors.length, true);
		for(let i = 0; i < this.sectors.length; i++) {
			dv.setUint32(0x104 + i*8, this.sectors[i], true);
			dv.setUint32(0x108 + i*8, this.sizes[i], true);
		}
		return new Blob([dv.buffer]);
	}
}