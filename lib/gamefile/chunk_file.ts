import Blob from "cross-blob";
import { GridChunk } from "../chunks/grid.js";

export enum ChunkType {
	EOF = 0,
	Materials = 2,
	WorldModel = 3,
	Image = 4,
	Collision = 5,
	ModelList = 8,
	DynamicModel = 12,
	Model = 13,
	Skeleton = 18,
	CharacterAssets = 18, // Not a typo, these really do have the same type ID.
	WorldGrid = 19,
	DynamicObjects = 29,
	Header = 31,
	AssetGroup = 32,
	ShadowModel = 33,
	ZoneVis = 35,
	LevelDLL = 37,
	Table = 42,
	DialogueTable = 1000,
	WorldInfo = 1001,
}

export class ChunkFile {
	constructor(public chunks : Chunk[]) {
	}

	static async from_blob(blob : Blob) : Promise<ChunkFile> {
		let chunks : Chunk[] = [];
		let offset = 0;
		while(true) {
			let chunk : Chunk;
			try {
				chunk = await Chunk.from_blob(blob);
			} catch(e) {
				if(chunks.length) {
					throw new Error("Chunk file is missing a terminator chunk");
				}
				throw e;
			}
			chunk.offset += offset;
			offset += chunk.contents.size + chunk.padding_bytes + 16;
			if(chunk.type == 0) break;
			chunks.push(chunk);
			blob = blob.slice(chunk.contents.size + chunk.padding_bytes + 16);

		}
		let out = new ChunkFile(chunks);
		out.original_size = offset;
		return out;
	}

	get_chunk_of_type(type : number, index = 0) : Chunk {
		for(let chunk of this.chunks) {
			if(chunk.type == type) {
				if(index <= 0) return chunk;
				else index--;
			}
		}
		throw new Error("Chunk of type " + type + " not found with index " + index);
	}

	get_chunks_of_type(type : number) : Chunk[] {
		let chunks = [];
		for(let chunk of this.chunks) {
			if(chunk.type == type) chunks.push(chunk);
		}
		return chunks;
	}

	get_chunk_by_id(type : number, id : number, index = 0) : Chunk {
		for(let chunk of this.chunks) {
			if(chunk.type == type && chunk.id == id) {
				if(index > 0)
					index--;
				else
					return chunk;
			}
		}
		throw new Error("Chunk of type " + type + " not found with id " + id + " and index " + index);
	}

	delete_chunk(chunk : Chunk) {
		let index = this.chunks.indexOf(chunk);
		if(index >= 0) this.chunks.splice(index, 1);
	}

	copy() {
		return new ChunkFile([...this.chunks]);
	}

	to_blob() : Blob {
		let pieces : Array<Blob|ArrayBuffer> = [];
		let offset = 0;
		for(let chunk of this.chunks) {
			let chunk_blob = chunk.to_blob(offset);
			offset += chunk_blob.size;
			pieces.push(chunk_blob);
		}
		// Put an end-of-file chunk at the end
		pieces.push(new Uint8Array([
			0x49, 0x44, 0x4d, 0x01,
			0x00, 0x00, 0x00, 0x00,
			0x10, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00
		]).buffer);
		return new Blob(pieces);
	}

	/**
	 * Rebuilds the collision world grid. Use after modifying collision. See {@link GridChunk.rebuild}
	 */
	async rebuild_grid() {
		let grid_chunk : Chunk|undefined = undefined;
		for(let chunk of this.chunks) {
			if(chunk.type == ChunkType.WorldGrid) {
				grid_chunk = chunk;
				break;
			}
		}
		if(!grid_chunk) {
			throw new Error("Cannot rebuild grid - no grid to rebuid");
		}

		let grid = await GridChunk.from_blob(grid_chunk.contents);
		await grid.rebuild(this);
		grid_chunk.contents = grid.to_blob();
	}

	original_size : number|undefined;
}

export class Chunk {
	offset = 0;

	constructor(public contents : Blob, public type : number, public id = 0, public padding_bytes = 0) {	
		this.offset += padding_bytes + 16;
	}

	static async from_blob(blob : Blob) : Promise<Chunk> {
		let header_dv = new DataView(await blob.slice(0, 16).arrayBuffer());
		if((header_dv.getInt32(0, true) & 0xFFFFFF) != 0x4d4449) {
			throw new Error("Blob passed to Chunk constructor is not a chunk file");
		}

		let type = header_dv.getInt16(4, true);
		let padding_bytes = header_dv.getInt16(6, true);
		let total_size = header_dv.getInt32(8, true);
		let id = header_dv.getInt16(14, true);
		let contents = blob.slice(16 + padding_bytes, total_size);
		return new Chunk(contents, type, id, padding_bytes);
	}

	get_alignment() : number {
		if(this.type == 37) return 0x80;
		return 0x10;
	}

	to_blob(offset = 0) : Blob {
		let alignment = this.get_alignment();
		let num_padding_bytes = (0x80 - (offset + 0x10)) & (alignment - 1);
		let header = new ArrayBuffer(num_padding_bytes + 0x10);
		let header_dv = new DataView(header);
		header_dv.setInt32(0, 0x4d4449, true);
		if(this.type == 37 || this.type == 4) {
			header_dv.setUint8(3, 4);
		} else if(this.type == 42 || this.type == 43) {
			header_dv.setUint8(3, 205)
		} else {
			header_dv.setUint8(3, 1);
		}
		header_dv.setInt16(4, this.type, true);
		header_dv.setInt16(6, num_padding_bytes, true);
		header_dv.setInt32(8, num_padding_bytes + 16 + this.contents.size, true);
		header_dv.setInt16(14, this.id, true);

		return new Blob([header, this.contents]);
	}

	copy() {
		let copy = new Chunk(this.contents, this.type, this.id, this.padding_bytes);
		copy.offset = this.offset;
		return copy;
	}
}
