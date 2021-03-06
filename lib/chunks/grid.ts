import assert from "assert";
import Blob from "cross-blob"
import { intersection } from "martinez-polygon-clipping";
import { ChunkFile, ChunkType } from "../gamefile/chunk_file.js";
import { apply_matrix, matrix_inverse, matrix_transpose } from "../utils/misc.js";
import { CollisionChunk } from "./collision.js";

export interface GridItem {
	load_id : number;
	collision_refs : GridCollisionRef[];
	fine_collision_refs : number[];
	breakable_refs : number[];
}

export interface GridCollisionRef {
	chunk_id : number;
	id : number;
	boundary_indices : number[];
}

export class GridChunk {
	constructor(
		public grid : Array<GridItem|undefined> = [],
		public width : number = 1,
		public height : number = 1,
		public x : number = -1.175,
		public z : number = -1.175,
		public scale : number = 25,
		public num_collision_chunks : number = 1
	) {}

	static async from_blob(blob : Blob) : Promise<GridChunk> {
		let dv = new DataView(await blob.arrayBuffer());
		let grid_scale = dv.getFloat32(0x10, true);
		let grid_x = dv.getFloat32(0x0, true);
		let grid_z = dv.getFloat32(0x8, true);
		let grid_width = dv.getUint32(0x14, true);
		let grid_height = dv.getUint32(0x18, true);
		let grid_ptr = dv.getUint32(0x1c, true);
		let num_collision_chunks = dv.getUint32(0x20, true);
		let grid = new Array<GridItem|undefined>(grid_width*grid_height);
		for(let y = 0; y < grid_height; y++) for(let x = 0; x < grid_width; x++) {
			let pointer = dv.getUint32(grid_ptr + (y*grid_width+x) * 4, true);
			if(pointer == 0) continue;

			let load_id = dv.getUint16(pointer + 0x18, true);
			let collision_refs : GridCollisionRef[] = [];

			let collision_refs_ptr = dv.getUint32(pointer + 0xC, true) + pointer;
			let num_collision_refs = dv.getUint32(pointer + 0x8, true);
			for(let i = 0; i < num_collision_refs; i++) {
				let collision_ref_ptr = collision_refs_ptr + 0x14*i;
				let chunk_id = dv.getUint32(collision_ref_ptr + 0x0, true);
				let id = dv.getUint32(collision_ref_ptr + 0x4, true);
				let boundary_indices_len = dv.getUint32(collision_ref_ptr + 0xC, true);
				let boundary_indices_ptr = dv.getUint32(collision_ref_ptr + 0x10, true) + collision_refs_ptr;

				let boundary_indices : number[] = [];
				for(let j = 0; j < boundary_indices_len; j++) {
					let index_ptr = dv.getUint32(boundary_indices_ptr + 4*j, true);
					let index = (index_ptr - 0x60) / 0x70;
					assert.strictEqual(index, index|0);
					boundary_indices.push(index);
				}

				collision_refs.push({
					id, boundary_indices, chunk_id
				});
			}

			let fine_collision_refs : number[] = [];
			let num_fine_collision_refs = dv.getUint32(pointer + 0x0, true);
			let fine_collision_refs_ptr = dv.getUint32(pointer + 0x4, true) + pointer;
			for(let i = 0; i < num_fine_collision_refs; i++) {
				fine_collision_refs.push(dv.getUint32(fine_collision_refs_ptr + 4*i, true));
			}

			let breakable_refs : number[] = [];
			let num_breakable_refs = dv.getUint32(pointer + 0x10, true);
			let breakable_refs_ptr = dv.getUint32(pointer + 0x14, true) + pointer;
			for(let i = 0; i < num_breakable_refs; i++) {
				breakable_refs.push(dv.getUint32(breakable_refs_ptr + 4*i, true));
			}

			grid[y*grid_width+x] = {
				load_id,
				collision_refs,
				fine_collision_refs,
				breakable_refs
			};
		}

		return new GridChunk(grid, grid_width, grid_height, grid_x, grid_z, grid_scale, num_collision_chunks);
	}

	to_blob() : Blob {
		let reservations = new Map<GridItem|GridCollisionRef[]|number[],number>();
		let total_length = 0;
		total_length += 0x28;
		total_length += this.num_collision_chunks*4;
		let grid_ptr = total_length;
		total_length += 0x4*this.width*this.height;
		for(let i = 0; i < this.width*this.height; i++) {
			let grid_item = this.grid[i];
			if(!grid_item) continue;
			reservations.set(grid_item, total_length);
			total_length += 0x1C;
			reservations.set(grid_item.fine_collision_refs, total_length);
			total_length += 4*grid_item.fine_collision_refs.length;
			reservations.set(grid_item.collision_refs, total_length);
			total_length += 0x14*grid_item.collision_refs.length;
			reservations.set(grid_item.breakable_refs, total_length);
			total_length += 4*grid_item.breakable_refs.length;
			for(let collision_ref of grid_item.collision_refs) {
				reservations.set(collision_ref.boundary_indices, total_length);
				total_length += 4*collision_ref.boundary_indices.length;
			}
		}

		let dv = new DataView(new ArrayBuffer(total_length));

		dv.setFloat32(0x0, this.x, true);
		dv.setFloat32(0x4, this.x + this.width*this.scale, true);
		dv.setFloat32(0x8, this.z, true);
		dv.setFloat32(0xC, this.z + this.height*this.scale, true);
		dv.setFloat32(0x10, this.scale, true);
		dv.setUint32(0x14, this.width, true);
		dv.setUint32(0x18, this.height, true);
		dv.setUint32(0x1C, grid_ptr, true);
		dv.setUint32(0x20, this.num_collision_chunks, true);
		dv.setUint32(0x24, 0x28, true);

		for(let y = 0; y < this.height; y++) for(let x = 0; x < this.width; x++) {
			let item = this.grid[y*this.width+x];
			if(!item) continue;
			let ptr = reservations.get(item);
			assert(ptr);
			dv.setUint32(grid_ptr + (y*this.width+x)*4, ptr, true);

			dv.setUint16(ptr+0x18, item.load_id, true);

			let collision_refs_ptr = reservations.get(item.collision_refs);
			let fine_collision_refs_ptr = reservations.get(item.fine_collision_refs);
			let breakable_refs_ptr = reservations.get(item.breakable_refs);
			assert(collision_refs_ptr);
			assert(fine_collision_refs_ptr);
			assert(breakable_refs_ptr);
			dv.setUint32(ptr+0x8, item.collision_refs.length, true);
			dv.setUint32(ptr+0xC, collision_refs_ptr - ptr, true);
			for(let i = 0; i < item.collision_refs.length; i++) {
				let collision_ref_ptr = collision_refs_ptr + i*0x14;
				let collision_ref = item.collision_refs[i];
				let boundary_indices_ptr = reservations.get(collision_ref.boundary_indices);
				assert(boundary_indices_ptr);

				dv.setUint32(collision_ref_ptr+0x0, collision_ref.chunk_id, true);
				dv.setUint32(collision_ref_ptr+0x4, collision_ref.id, true);
				dv.setUint32(collision_ref_ptr+0xC, collision_ref.boundary_indices.length, true);
				dv.setUint32(collision_ref_ptr+0x10, boundary_indices_ptr - collision_refs_ptr, true);
				for(let j = 0; j < collision_ref.boundary_indices.length; j++) {
					dv.setUint32(boundary_indices_ptr + j*4, collision_ref.boundary_indices[j]*0x70 + 0x60, true);
				}
			}
			
			dv.setUint32(ptr+0x0, item.fine_collision_refs.length, true);
			dv.setUint32(ptr+0x4, fine_collision_refs_ptr - ptr, true);
			for(let i = 0; i < item.fine_collision_refs.length; i++) {
				dv.setUint32(fine_collision_refs_ptr+i*4, item.fine_collision_refs[i], true);
			}

			dv.setUint32(ptr+0x10, item.breakable_refs.length, true);
			dv.setUint32(ptr+0x14, breakable_refs_ptr - ptr, true);
			for(let i = 0; i < item.breakable_refs.length; i++) {
				dv.setUint32(breakable_refs_ptr+i*4, item.breakable_refs[i], true);
			}
		}

		return new Blob([dv.buffer]);
	}

	get_or_create_tile(int_x : number, int_z : number) : GridItem {
		assert(int_x >= 0 && int_z >= 0 && int_x < this.width && int_z < this.height, "Tile coordinates out of range");
		let i = int_x + this.width*int_z;
		let item = this.grid[i];
		if(item) return item;
		return this.grid[i] = {
			collision_refs: [],
			fine_collision_refs: [],
			breakable_refs: [],
			load_id: 0
		};
	}
	get_tile(int_x : number, int_z : number) : GridItem|undefined {
		assert(int_x >= 0 && int_z >= 0 && int_x < this.width && int_z < this.height, "Tile coordinates out of range");
		let i = int_x + this.width*int_z;
		return this.grid[i];
	}

	get_tiles_in_rect(minx : number, minz : number, maxx : number, maxz : number) : [number,number][] {
		let int_minx = Math.floor((minx - this.x) / this.scale);
		let int_minz = Math.floor((minz - this.z) / this.scale);
		let int_maxx = Math.floor((maxx - this.x) / this.scale)+1;
		let int_maxz = Math.floor((maxz - this.z) / this.scale)+1;

		if(int_minx < 0 || int_minz < 0 || int_maxx > this.width || int_maxz > this.height) {
			let expand_up, expand_left;
			this.expand_grid(
				expand_left = Math.max(-int_minx, 0),
				expand_up = Math.max(-int_minz, 0),
				Math.max(int_maxx-this.width, 0),
				Math.max(int_maxz-this.height,0)
			);
			int_minx += expand_left;
			int_maxx += expand_left;
			int_minz += expand_up;
			int_maxz += expand_up;
		}
		let items : [number,number][] = [];
		for(let z = int_minz; z < int_maxz; z++) for(let x = int_minx; x < int_maxx; x++) {
			items.push([x,z]);
		}
		return items;
	}

	expand_grid(expand_left:number, expand_up:number, expand_right:number, expand_down:number) {
		expand_left = expand_left|0;
		expand_right = expand_right|0;
		expand_up = expand_up|0;
		expand_down = expand_down|0;

		let new_width = Math.max(this.width + expand_left + expand_right, 0);
		let new_height = Math.max(this.height + expand_up + expand_down, 0);

		let new_grid = new Array<GridItem|undefined>(new_width*new_height);
		for(let y = 0; y < this.height; y++) for(let x = 0; x < this.width; x++) {
			let new_y = y+expand_up;
			let new_x = x+expand_left;
			if(new_y >= 0 && new_x >= 0 && new_x < new_width && new_y < new_height)
				new_grid[(new_y)*new_width + new_x] = this.grid[y*this.width+x];
		}
		this.grid = new_grid;
		this.x -= this.scale*expand_left;
		this.z -= this.scale*expand_up;
		this.width = new_width;
		this.height = new_height;
	}

	/**
	 * Rebuilds references to collision objects within this grid
	 * @param file A chunk file containing the world with the relevant collision objects
	 * @param do_trim Whether to trim the grid afterwards (See {@link trim})
	 */
	async rebuild(file : ChunkFile, do_trim = true) {
		//this.num_collision_chunks = 0;
		for(let item of this.grid) {
			if(!item) continue;
			item.collision_refs = [];
		}
		for(let collision_chunk of file.get_chunks_of_type(ChunkType.Collision)) {
			let collision = await CollisionChunk.from_blob(collision_chunk.contents);
			
			this.add_collision(collision);
		}
		
		if(do_trim) this.trim();
	}

	/**
	 * Adds references to collision objects.
	 * @param collision 
	 */
	add_collision(collision : CollisionChunk) {
		this.num_collision_chunks = Math.max(this.num_collision_chunks, collision.id + 1);
		this.remove_collision(collision);

		let to_ignore = new Set<number>();
		for(let [index, object] of collision.objects.entries()) {
			if(index != object.water_splash_object) to_ignore.add(object.water_splash_object);
		}

		for(let [index, object] of collision.objects.entries()) {
			if(to_ignore.has(index)) continue; // Water splash effects are visual only
			for(let [x,z] of this.get_tiles_in_rect(object.aabb_start[0]-1.075, object.aabb_start[1]-1.075, object.aabb_end[0]+1.075, object.aabb_end[1]+1.075)) {
				let tile_shape = [[[
					[this.x+x*this.scale, -this.z-z*this.scale],
					[this.x+x*this.scale, -this.z-(z+1)*this.scale],
					[this.x+(x+1)*this.scale, -this.z-(z+1)*this.scale],
					[this.x+(x+1)*this.scale, -this.z-z*this.scale],
					[this.x+x*this.scale, -this.z-z*this.scale],
				]]];
				let boundary_indices : number[] = [];
				for(let [bound_index, bound] of object.bounds.entries()) {
					let inv_mat = matrix_inverse(matrix_transpose([...bound.matrix, 0, 0, 0, 1]));
					assert(inv_mat, "Collision boundary has a degenerate matrix");
					let dl = apply_matrix(inv_mat, [0, -1.175, 0]);
					let dr = apply_matrix(inv_mat, [0, bound.width+1.175, 0]);
					let bound_shape = [[[
						[dl[0]-bound.matrix[0]*0.3,-dl[2]+bound.matrix[2]*0.3],
						[dr[0]+bound.matrix[0]*1.175,-dr[2]-bound.matrix[2]*1.175],
						[dr[0]+bound.matrix[0]*1.175,-dr[2]-bound.matrix[2]*1.175],
						[dr[0]-bound.matrix[0]*0.3,-dr[2]+bound.matrix[2]*0.3],
						[dl[0]-bound.matrix[0]*0.3,-dl[2]+bound.matrix[2]*0.3]
					]]];
					if(intersection(bound_shape, tile_shape)?.length) boundary_indices.push(bound_index);
				}
				this.get_or_create_tile(x,z).collision_refs.push({
					chunk_id: collision.id,
					id: index,
					boundary_indices: boundary_indices
				});
			}
		}
	}
	
	/**
	 * Removes references to collision objects with matching ID
	 * @param collision Collision chunk or ID of collision chunk
	 */
	remove_collision(collision : CollisionChunk|number) {
		let id = (typeof collision === "number") ? collision : collision.id;
		for(let item of this.grid) {
			if(item) {
				item.collision_refs = item.collision_refs.filter(ref => ref.chunk_id !== id);
			}
		}
	}

	/**
	 * Removes empty tiles from the grid, and shrinks the grid boundaries down
	 * to fit the non-empty grid
	 */
	trim() {
		let minx = 10000;
		let minz = 10000;
		let maxx = -10000;
		let maxz = -10000;
		for(let z = 0; z < this.height; z++) for(let x = 0; x < this.width; x++) {
			let tile = this.grid[z*this.width+x];
			if(!tile) continue;
			if(tile.load_id == 0 && tile.collision_refs.length == 0 && tile.fine_collision_refs.length == 0 && tile.breakable_refs.length == 0) {
				this.grid[z*this.width+x] = undefined;
				continue;
			}
			minx = Math.min(minx, x);
			minz = Math.min(minz, z);
			maxx = Math.max(maxx, x+1);
			maxz = Math.max(maxz, z+1);
		}
		this.expand_grid(-minx, -minz, maxx-this.width, maxz-this.height);
	}
}