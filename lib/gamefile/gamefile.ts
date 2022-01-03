import Blob from "cross-blob";
import { ChunkFile } from "./chunk_file.js";
import { guess_sector_map, SectorMap } from "./sector_map.js";

/**
 * A class for reading and modifying the GAMEFILE.DAT file on the game disc,
 * as well as some sub-files within GAMEFILE.DAT.
 */
export class Gamefile {
	#sector_map : SectorMap;
	#blob : Blob;
	#file_replacements : Map<number, Blob> = new Map();
	/**
	 * 
	 * @param blob 
	 * @param sector_map A listing of the locations of files within this blob. If not passed in, will try to guess based on the size of the blob.
	 */
	constructor(blob : Blob, sector_map? : SectorMap) {
		if(!sector_map) sector_map = guess_sector_map(blob.size);
		this.#sector_map = {sectors: [...sector_map.sectors], sizes: [...sector_map.sizes]};
		Object.freeze(this.#sector_map);
		Object.freeze(this.#sector_map.sectors);
		Object.freeze(this.#sector_map.sizes);
		this.#blob = blob;
	}

	get num_files() {return this.#sector_map.sectors.length;}

	get_file(index : number) : Blob {
		if(index < 0 || index >= this.#sector_map.sectors.length) throw new Error("Could not get file - invalid index " + index);
		let replacement = this.#file_replacements.get(index);
		if(replacement) return replacement;
		let sector = this.#sector_map.sectors[index];
		let size = this.#sector_map.sizes[index];
		return this.#blob.slice(sector * 2048, (sector+size) * 2048);
	}

	replace_file(index : number, blob : Blob|undefined) : void {
		if(index < 0 || index >= this.#sector_map.sectors.length) throw new Error("Could not replace file - invalid index " + index);
		if(!blob) blob = new Blob();
		this.#file_replacements.set(index, blob);
	}

	get_chunk_file(index : number) : Promise<ChunkFile> {
		return ChunkFile.from_blob(this.get_file(index));
	}
	replace_chunk_file(index : number, file : ChunkFile) : void{
		this.replace_file(index, file.to_blob());
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
}

// Some quick stuff - Size limit for transitions is 0x44B000 or 4,501,504, and size limit for exteriors is 0x9b5000 or 10,178,560

const zero_blob = new Blob([new ArrayBuffer(2048)]);
