import assert from "assert";
import Blob from "cross-blob";
import { lerp } from "../utils/misc.js";

export class CollisionObject {
	mask : number = 0;
	/** -x/-z corner of 2d bounding box, expanded by 0.1 feet. Used as the origin of the heightmap grid */
	aabb_start : [number, number] = [0,0];
	/** +x/+z corner of 2d bounding box, expanded by 0.1 feet */
	aabb_end : [number, number] = [0,0];
	bounds : CollisionBoundary[] = [];
	/** What happens when this object's floor is walked on */
	floor_type : FloorType = FloorType.Normal;
	/** Where the player gets sent if drowning on this object's floor. A value of -1 is a game over. */
	drown_target : number = -1;
	/** An index of another object where splashing effects are displayed */
	water_splash_object : number = -1;
	floor_material : FloorMaterial = FloorMaterial.Dirt;
	zone : number = 0;

	inner_tile_size : number = 1;
	outer_tile_size : number = 1;
	outer_grid_width : number = 0;
	outer_grid_height : number = 0;
	inner_grid_size : number = 2;

	heightmap_grid : Array<number[]|undefined> = [];

	get_heightmap_y(x : number, z : number, expand = true) : number {
		let ox_float = (x - this.aabb_start[0]) / this.outer_tile_size;
		let oz_float = (z - this.aabb_start[1]) / this.outer_tile_size;
		let ox = Math.floor(ox_float);
		let oz = Math.floor(oz_float);
		let grid_width = this.outer_grid_width;
		let grid_height = this.outer_grid_height;
		if((ox<0 || oz<0 || ox>=grid_width || oz>=grid_height || this.heightmap_grid[grid_width*oz+ox] == undefined) && expand) {
			let rx = ox_float-ox;
			let rz = ox_float-oz;
			ox = Math.max(0, Math.min(grid_width-1, ox));
			oz = Math.max(0, Math.min(grid_height-1, oz));
			if(this.heightmap_grid[grid_width*oz+ox] == undefined) {
				if(rx > 0.9 && (ox+1) < grid_width && this.heightmap_grid[grid_width*oz+(ox+1)]) ox++;
				else if(rx < 0.1 && (ox-1) >= 0 && this.heightmap_grid[grid_width*oz+(ox-1)]) ox--;
				else if(rz > 0.9 && (oz+1) < grid_height && this.heightmap_grid[grid_width*(oz+1)+ox]) oz++;
				else if(rz < 0.1 && (oz-1) >= 0 && this.heightmap_grid[grid_width*(oz-1)+ox]) oz--;
			}
		}
		if(ox<0 || oz<0 || ox>=grid_width || oz>=grid_height) return this.bounds[0]?.origin[1] ?? 0;
		let grid = this.heightmap_grid[grid_width*oz+ox];
		if(!grid) return this.bounds[0]?.origin[1] ?? 0;
		let ix_float = (ox_float - ox) * this.outer_tile_size / this.inner_tile_size;
		let iz_float = (oz_float - oz) * this.outer_tile_size / this.inner_tile_size;
		let ix = Math.max(0, Math.min(this.inner_grid_size-2, Math.floor(ix_float)))
		let iz = Math.max(0, Math.min(this.inner_grid_size-2, Math.floor(iz_float)))
		let inner_size = this.inner_grid_size;

		let a = grid[iz*inner_size+ix];
		let b = grid[iz*inner_size+(ix+1)];
		let c = grid[(iz+1)*inner_size+ix];
		let d = grid[(iz+1)*inner_size+(ix+1)];

		return lerp(lerp(a, b, ix_float-ix), lerp(c, d, ix_float-ix), iz_float-iz);
	}
}

export interface CollisionBoundary {
	/** Location of the upper left corner of the wall/boundary */
	origin : [number, number, number];
	matrix: CollisionMatrix;
	width: number;
	height: number;
	/** Z-coordinate of the right edge of the wall/boundary minus the z-coordinate of the left edge */
	z_size: number;
	to_left : number|undefined;
	to_right : number|undefined;
}

export type CollisionMatrix = [number,number,number,number,number,number,number,number,number,number,number,number];

export enum FloorType {
	None = -1,
	Normal = 0,
	SlowWalk = 1,
	Drown = 2
}

export enum FloorMaterial {
	Dirt = 0,
	Grass = 1,
	Lava = 2,
	Metal = 3,
	MetalGrate = 4,
	Muck = 5,
	Stone = 6,
	Treasure = 7,
	Water = 8,
	Wood = 9,
	WoodBridge = 10,
	FastWater = 11,
	LooseRock = 12,
	Leaf = 13,
	Flower = 14,
	Pollen = 15,
	Coal = 16,
	StrawRoof = 17,
	Twigs = 18,
	Bone = 19
}

export class CollisionChunk {
	constructor(public objects : CollisionObject[], public id : number = 0) {}

	static async from_blob(blob : Blob) : Promise<CollisionChunk> {
		let dv = new DataView(await blob.arrayBuffer());

		let id = dv.getUint32(0, true);
		let num_collision_objects = dv.getUint32(4, true);
		let collision_objects_ptr = dv.getUint32(8, true);
		let objects : CollisionObject[] = [];
		for(let i = 0; i < num_collision_objects; i++) {
			let ptr = dv.getUint32(collision_objects_ptr + i*4, true);

			let object = new CollisionObject();

			object.aabb_start = [dv.getFloat32(ptr + 0x28, true), dv.getFloat32(ptr + 0x2C, true)];
			object.aabb_end = [dv.getFloat32(ptr + 0x30, true), dv.getFloat32(ptr + 0x34, true)];
			object.mask = dv.getUint16(ptr + 0x42, true);
			object.floor_type = dv.getInt32(ptr + 0x38, true);
			object.floor_material = dv.getUint32(ptr + 0x40, true);
			object.zone = dv.getUint8(ptr + 0xC);
			object.drown_target = dv.getInt8(ptr + 0xD);
			object.water_splash_object = dv.getInt16(ptr + 0xE, true);

			object.outer_tile_size = dv.getFloat32(ptr + 0x10, true);
			object.inner_tile_size = dv.getFloat32(ptr + 0x14, true);
			object.inner_grid_size = dv.getUint32(ptr + 0x1c, true);
			object.outer_grid_width = dv.getUint32(ptr + 0x20, true);
			object.outer_grid_height = dv.getUint32(ptr + 0x24, true);

			let outer_grid_size = object.outer_grid_width*object.outer_grid_height;
			let outer_grid_ptr = ptr + dv.getUint32(ptr + 0x4c, true);
			
			for(let i = 0; i < outer_grid_size; i++) {
				let inner_grid_ptr = dv.getUint32(outer_grid_ptr + i * 4, true);
				if(!inner_grid_ptr) {
					object.heightmap_grid.push(undefined); continue;
				}
				inner_grid_ptr += ptr;
				inner_grid_ptr += dv.getUint32(inner_grid_ptr, true);
				let inner_grid : number[] = [];
				for(let i = 0; i < object.inner_grid_size*object.inner_grid_size; i++) {
					inner_grid.push(dv.getFloat32(inner_grid_ptr+i*4, true));
				}
				object.heightmap_grid.push(inner_grid);
			}

			let num_boundaries = dv.getUint32(ptr + 0x50, true);
			let bounds_ptr = ptr + dv.getUint32(ptr + 0x54, true);
			for(let j = 0; j < num_boundaries; j++) {
				let bound_ptr = bounds_ptr + 0x70*j;
				let origin : [number,number,number] = [
					dv.getFloat32(bound_ptr, true),
					dv.getFloat32(bound_ptr+4, true),
					dv.getFloat32(bound_ptr+8, true)
				];
				let matrix : CollisionMatrix = [0,0,0,0,0,0,0,0,0,0,0,0];
				for(let k = 0; k < 12; k++) {
					matrix[k] = dv.getFloat32(bound_ptr + 0x10 + 4*k, true);
				}
				let width = dv.getFloat32(bound_ptr + 0x40, true);
				let height = dv.getFloat32(bound_ptr + 0x44, true);
				let to_right = (dv.getUint32(bound_ptr + 0x54, true) - bounds_ptr + ptr) / 0x70;
				let to_left = (dv.getUint32(bound_ptr + 0x5C, true) - bounds_ptr + ptr) / 0x70;
				let z_size = dv.getFloat32(bound_ptr + 0x68, true);
				object.bounds.push({
					origin, matrix, width, height, z_size, to_left, to_right
				});
			}
			objects.push(object);
		}
		return new CollisionChunk(objects, id);
	}

	to_blob() : Blob {
		let reservations = new Map<CollisionObject|CollisionBoundary|Array<number[]|undefined>|number[], number>();
		let total_length = 0x10 + this.objects.length * 4;
		for(let object of this.objects) {
			// I prefer to have very specific offsets here, 
			// consistent with the original game to reduce interdependency with the grid 
			// chunk, rather than try to optimize this down.
			total_length = Math.ceil(total_length / 0x10) * 0x10;
			reservations.set(object, total_length);
			total_length += 0x60;
			for(let boundary of object.bounds) {
				total_length = Math.ceil(total_length / 0x10) * 0x10;
				reservations.set(boundary, total_length);
				total_length += 0x70;
			}
			reservations.set(object.heightmap_grid, total_length);
			total_length += (4*object.outer_grid_width*object.outer_grid_height);
			for(let i = 0; i < object.outer_grid_width*object.outer_grid_height; i++) {
				let inner_grid = object.heightmap_grid[i];
				if(inner_grid) {
					reservations.set(inner_grid, total_length);
					total_length += 4 + (object.inner_grid_size*object.inner_grid_size*4);
				}
			}
		}

		total_length = Math.ceil(total_length / 0x10) * 0x10;
		let dv = new DataView(new ArrayBuffer(total_length));

		dv.setUint32(0, this.id, true);
		dv.setUint32(4, this.objects.length, true);
		dv.setUint32(8, 0x10, true);
		for(let [object_index, object] of this.objects.entries()) {
			let ptr = reservations.get(object);
			assert(ptr != undefined);
			dv.setUint32(0x10+object_index*4, ptr, true);
			dv.setUint32(ptr + 0x4, this.id, true);
			dv.setUint32(ptr + 0x8, object_index, true);
			dv.setUint8(ptr + 0xC, object.zone);
			dv.setInt8(ptr + 0xD, object.drown_target);
			dv.setInt16(ptr + 0xE, object.water_splash_object, true);
			dv.setFloat32(ptr + 0x10, object.outer_tile_size, true);
			dv.setFloat32(ptr + 0x14, object.inner_tile_size, true);
			dv.setUint32(ptr + 0x18, object.inner_grid_size - 1, true);
			dv.setUint32(ptr + 0x1c, object.inner_grid_size, true);
			dv.setUint32(ptr + 0x20, object.outer_grid_width, true);
			dv.setUint32(ptr + 0x24, object.outer_grid_height, true);
			dv.setFloat32(ptr + 0x28, object.aabb_start[0], true);
			dv.setFloat32(ptr + 0x2C, object.aabb_start[1], true);
			dv.setFloat32(ptr + 0x30, object.aabb_end[0], true);
			dv.setFloat32(ptr + 0x34, object.aabb_end[1], true);
			dv.setInt32(ptr + 0x38, object.floor_type, true);
			dv.setUint32(ptr + 0x40, object.floor_material, true);
			let filtered_heightmaps = object.heightmap_grid.filter(thing => thing != undefined) as number[][];
			dv.setUint32(ptr + 0x44, filtered_heightmaps.length, true);
			if(filtered_heightmaps.length) dv.setUint32(ptr + 0x48, (reservations.get(filtered_heightmaps[0]) ?? 0)-ptr, true);
			dv.setUint32(ptr + 0x50, object.bounds.length, true);
			dv.setUint32(ptr + 0x54, object.bounds.length ? (reservations.get(object.bounds[0]) ?? 0)-ptr : 0, true);
			for(let [bound_index, bound] of object.bounds.entries()) {
				let bound_ptr = reservations.get(bound);
				assert(bound_ptr != undefined);

				dv.setFloat32(bound_ptr, bound.origin[0], true);
				dv.setFloat32(bound_ptr+4, bound.origin[1], true);
				dv.setFloat32(bound_ptr+8, bound.origin[2], true);
				dv.setFloat32(bound_ptr+12, 1, true);
				for(let i = 0; i < 12; i++) {
					dv.setFloat32(bound_ptr+16+i*4, bound.matrix[i], true);
				}
				dv.setFloat32(bound_ptr+0x40, bound.width, true);
				dv.setFloat32(bound_ptr+0x44, bound.height, true);
				dv.setUint32(bound_ptr+0x48, bound_ptr - ptr, true);
				if(bound.to_right != undefined) {
					let to_right = object.bounds[bound.to_right];
					let to_right_ptr = reservations.get(to_right);
					assert(to_right_ptr != undefined);
					dv.setUint32(bound_ptr+0x54, to_right_ptr - ptr, true);
				}
				if(bound.to_left != undefined) {
					let to_left = object.bounds[bound.to_left];
					let to_left_ptr = reservations.get(to_left);
					assert(to_left_ptr != undefined);
					dv.setUint32(bound_ptr+0x5C, to_left_ptr - ptr, true);
				}
				let next = object.bounds[(bound_index + 1) % object.bounds.length];
				let next_ptr = reservations.get(next);
				assert(next_ptr != undefined);
				dv.setUint32(bound_ptr + 0x60, next_ptr - ptr, true);
				dv.setFloat32(bound_ptr + 0x68, bound.z_size, true);
			}

			let grid_ptr = reservations.get(object.heightmap_grid);
			assert(grid_ptr != undefined);
			dv.setUint32(ptr + 0x4C, grid_ptr - ptr, true);
			for(let i = 0; i < object.outer_grid_height*object.outer_grid_width; i++) {
				let heightmap = object.heightmap_grid[i];
				if(heightmap == undefined) {
					dv.setUint32(grid_ptr + i*4, 0, true);
				} else {
					let heightmap_ptr = reservations.get(heightmap);
					assert(heightmap_ptr != undefined);
					dv.setUint32(grid_ptr + i*4, heightmap_ptr - ptr, true);
					dv.setUint32(heightmap_ptr, 4, true);
					for(let j = 0; j < object.inner_grid_size*object.inner_grid_size; j++) {
						dv.setFloat32(heightmap_ptr+4+j*4, heightmap[j], true);
					}
				}
			}
		}
		return new Blob([dv.buffer]);
	}
}
