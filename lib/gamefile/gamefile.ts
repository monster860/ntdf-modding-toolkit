import Blob from "cross-blob";
import { ChunkFile } from "./chunk_file.js";
import { export_sector_map, guess_sector_map, import_sector_map, SectorMap } from "./sector_map.js";

/**
 * A class for reading and modifying the GAMEFILE.DAT file on the game disc,
 * as well as some sub-files within GAMEFILE.DAT.
 */
export class Gamefile {
	#sector_map : SectorMap;
	#blob : Blob;
	#file_replacements : Map<number, Blob> = new Map();
	#file_cache : Map<number, Blob> = new Map();
	/**
	 * 
	 * @param blob 
	 * @param sector_map A listing of the locations of files within this blob. If not passed in, will try to guess based on the size of the blob.
	 */
	constructor(blob : Blob, sector_map? : SectorMap) {
		if(!sector_map) sector_map = guess_sector_map(blob.size);
		if(Object.isFrozen(sector_map) && Object.isFrozen(sector_map.sectors) && Object.isFrozen(sector_map.sizes)) {
			this.#sector_map = sector_map;
		} else {
			this.#sector_map = {sectors: [...sector_map.sectors], sizes: [...sector_map.sizes]};
			Object.freeze(this.#sector_map);
			Object.freeze(this.#sector_map.sectors);
			Object.freeze(this.#sector_map.sizes);
		}
		this.#blob = blob;
	}

	copy() : Gamefile {
		let copy = new Gamefile(this.#blob, this.#sector_map);
		copy.#sector_map = this.#sector_map;
		copy.#file_replacements = new Map(this.#file_replacements);
		copy.#file_cache = new Map(this.#file_cache);
		return copy;
	}

	get num_files() {return this.#sector_map.sectors.length;}

	get_file(index : number) : Blob {
		if(index < 0 || index >= this.#sector_map.sectors.length) throw new Error("Could not get file - invalid index " + index);
		let replacement = this.#file_replacements.get(index);
		if(replacement) return replacement;
		let cached = this.#file_cache.get(index);
		if(cached) return cached;
		let sector = this.#sector_map.sectors[index];
		let size = this.#sector_map.sizes[index];
		let file = this.#blob.slice(sector * 2048, (sector+size) * 2048);
		this.#file_cache.set(index, file);
		return file;
	}

	replace_file(index : number, blob : Blob|undefined) : this {
		if(index < 0 || index >= this.#sector_map.sectors.length) throw new Error("Could not replace file - invalid index " + index);
		if(!blob) blob = new Blob();
		this.#file_replacements.set(index, blob);
		return this;
	}

	get_chunk_file(index : number) : Promise<ChunkFile> {
		return ChunkFile.from_blob(this.get_file(index));
	}
	replace_chunk_file(index : number, file : ChunkFile) : this {
		this.replace_file(index, file.to_blob());
		return this;
	}

	#commit_changes() {
		if(!this.#file_replacements.size) return;
		let parts : Blob[] = [];
		let ptr = 0;
		let sectors : number[] = [];
		let sizes : number[] = [];
		for(let i = 0; i < this.num_files; i++) {
			let replacement = this.#file_replacements.get(i);
			if(replacement) {
				this.#file_cache.set(i, replacement);
				if(replacement.size) parts.push(replacement);
				sectors.push(Math.ceil(ptr / 2048));
				ptr += replacement.size;
				sizes.push(Math.ceil(replacement.size / 2048));
				let padding_bytes = Math.ceil(ptr / 2048) * 2048 - ptr;
				if(padding_bytes) {
					ptr += padding_bytes;
					parts.push(zero_blob.slice(0, padding_bytes));
				}
			} else {
				let begin_sector = this.#sector_map.sectors[i];
				let curr_sector = this.#sector_map.sectors[i];
				while(!this.#file_replacements.get(i) && this.#sector_map.sectors[i] == curr_sector) {
					sectors.push(Math.ceil(ptr / 2048));
					sizes.push(this.#sector_map.sizes[i]);
					ptr += this.#sector_map.sizes[i] * 2048;
					curr_sector += this.#sector_map.sizes[i];
					i++;
				}
				if(curr_sector != begin_sector) {
					parts.push(this.#blob.slice(begin_sector*2048, curr_sector*2048));
				}
				i--;
			}
		}
		this.#sector_map = {sectors, sizes};
		Object.freeze(this.#sector_map);
		Object.freeze(this.#sector_map.sectors);
		Object.freeze(this.#sector_map.sizes);
		this.#blob = new Blob(parts);
		this.#file_replacements.clear();
	}

	get sector_map() : SectorMap {
		this.#commit_changes();
		return this.#sector_map;
	}
	get blob() : Blob {
		this.#commit_changes();
		return this.#blob;
	}

	static async from_iso(iso_blob : Blob) {
		let exe_blob = iso_blob.slice(ISO_EXE_LOC, ISO_EXE_LOC+ISO_EXE_SIZE);
		let sector_map = await import_sector_map(exe_blob);
		let gamefile_size = 0;
		for(let i = 0; i < sector_map.sectors.length; i++) {
			gamefile_size = Math.max(gamefile_size, sector_map.sectors[i] + sector_map.sizes[i]);
		}
		gamefile_size *= 2048;
		let gamefile_blob = iso_blob.slice(ISO_GAMEFILE_LOC, ISO_GAMEFILE_LOC+gamefile_size);
		return new Gamefile(gamefile_blob, sector_map);
	}
	async patch_iso(iso_blob : Blob) : Promise<Blob> {
		let exe_blob = iso_blob.slice(ISO_EXE_LOC, ISO_EXE_LOC+ISO_EXE_SIZE);
		let modified_exe = await export_sector_map(exe_blob, this.sector_map);

		return new Blob([
			iso_blob.slice(0, ISO_EXE_LOC),
			modified_exe,
			iso_blob.slice(ISO_EXE_LOC + modified_exe.size, ISO_GAMEFILE_LOC),
			this.blob,
			iso_blob.slice(Math.min(iso_blob.size, ISO_GAMEFILE_LOC + this.blob.size))
		]);
	}

	*[Symbol.iterator]() : IterableIterator<Blob> {
		for(let i = 0; i < this.num_files; i++) {
			yield this.get_file(i);
		}
	}

	static TRANSITION_SIZE_LIMIT = 0x44B000;
	static EXTERIOR_SIZE_LIMIT = 0x9B5000;
}

const ISO_EXE_LOC = 390*2048;
const ISO_EXE_SIZE = 2291560;
const ISO_GAMEFILE_LOC = 885373*2048;

const zero_blob = new Blob([new ArrayBuffer(2048)]);
