import { Vec4 } from "./misc";

// Why not use an existing library you say?
// Because NONE of them support having palettes of RGBA colors.

/**
 * Generates a color palette for RGBA image.
 * @param data 
 * @param max_colors_log Log of the number of colors. Use 8 for 256 colors and 4 for 16 colors.
 * @param premultiply
 */
export function generate_rgba_palette(data: Uint8Array | Uint8Array[], max_colors_log = 8, premultiply = true) : Uint8Array {
	// Uses median cut algorithm
	let buckets : Vec4[][] = [[]];
	if(!(data instanceof Array)) data = [data];
	let has_alpha_zero = false;
	for(let buf of data) {
		for(let i = 0; i < buf.length; i += 4) {
			let alpha = premultiply ? (buf[i+3] / 255) : 1;
			buckets[0].push([
				buf[i]*alpha,
				buf[i+1]*alpha,
				buf[i+2]*alpha,
				buf[i+3]
			]);
			if(alpha == 0) has_alpha_zero = true;
		}
	}
	for(let i = 0; i < max_colors_log; i++) {
		let new_buckets : Vec4[][] = [];
		let colors_per_bucket = (1 << (max_colors_log - i - 1))
		for(let bucket of buckets) {
			let min_rgba = [255,255,255,255];
			let max_rgba = [0,0,0,0];
			for(let color of bucket) {
				for(let j = 0; j < 4; j++) {
					min_rgba[j] = Math.min(min_rgba[j], color[j]);
					max_rgba[j] = Math.max(max_rgba[j], color[j]);
				}
			}
			let sort_channel = 0;
			let sort_channel_range = 0;
			for(let j = 0; j < 4; j++) {
				let range = max_rgba[j] - min_rgba[j];
				if(range > sort_channel_range) {
					sort_channel = j;
					sort_channel_range = range;
				}
			}

			bucket.sort((a, b) => {
				return a[sort_channel] - b[sort_channel];
			});
			let half = Math.floor(bucket.length/2);
			let color_set = new Set<string>();
			let half_color_point = -1;
			for(let [index, color] of bucket.entries()) {
				let str = color.toString();
				color_set.add(str);
				if(color_set.size > colors_per_bucket && half_color_point < 0) {
					half_color_point = Math.max(half, index);
				}
			}
			if(color_set.size <= colors_per_bucket*2) half = half_color_point;
			new_buckets.push(bucket.slice(0, half), bucket.slice(half));
		}
		buckets = new_buckets;
	}
	let palette_float : Vec4[] = buckets.map(bucket => {
		let sum:Vec4 = [0,0,0,0];
		for(let color of bucket) {
			for(let i = 0; i < 4; i++) {
				sum[i] += color[i];
			}
		}
		let inv_len = 1/bucket.length;
		for(let i = 0; i < 4; i++) {
			sum[i] *= inv_len;
		}
		return sum;
	});
	palette_float.sort((a, b) => {
		if(a[3] == 0 && b[3] != 0) return -1;
		if(a[3] != 0 && b[3] == 0) return 1;
		return (a[0]+a[1]+a[2]) - (b[0]+b[1]+b[2]);
	});
	if(has_alpha_zero) {
		palette_float[0][3] = 0;
	}
	let out_buf = new Uint8Array(palette_float.length*4);
	for(let i = 0; i < palette_float.length; i++) {
		let color = palette_float[i];
		let inv_alpha = premultiply ? (255/color[3]) : 1;
		out_buf[i*4+0] = Math.max(0, Math.min(255, color[0] / inv_alpha));
		out_buf[i*4+1] = Math.max(0, Math.min(255, color[1] / inv_alpha));
		out_buf[i*4+2] = Math.max(0, Math.min(255, color[2] / inv_alpha));
		out_buf[i*4+3] = Math.max(0, Math.min(255, color[3]));
	}
	return out_buf;
}

/**
 * Takes in an RGBA image data, and applies the palette to it, returning an 8-bit image.
 * @param in_data 
 * @param palette 
 * @param premultiply Whether to use premultiplied colors in the distance function
 * @returns 
 */
export function quantize_image(in_data : Uint8Array, palette : Uint8Array, premultiply = true) : Uint8Array {
	let data = new Uint8Array(in_data.length >> 2);
	for(let i = 0; i < data.length; i++) {
		let ia = in_data[i*4+3];
		let im = premultiply ? ia/255 : 1;
		let ir = in_data[i*4] * im;
		let ig = in_data[i*4+1] * im;
		let ib = in_data[i*4+2] * im;
		let best_index = 0;
		let best_distance = Infinity;
		for(let j = 0; j < palette.length>>2; j++) {
			let pa = palette[j*4+3];
			let pm = premultiply ? pa/255 : 1;
			let pr = palette[j*4] * pm;
			let pg = palette[j*4+1] * pm;
			let pb = palette[j*4+2] * pm;
			let distance = (pa-ia)**2 + (pr-ir)**2 + (pg-ig)**2 + (pb-ib)**2;
			if(distance < best_distance) {
				best_distance = distance;
				best_index = j;
			}
		}
		
		data[i] = best_index;
	}

	return data;
}
