import assert from "assert";
import { GsStorageFormat } from "../ps2/gs_constants.js";
import { deswizzle_32, swizzle_4, swizzle_8, swizzle_clut_buffer } from "../ps2/swizzle.js";
import { insert_bits } from "../utils/misc.js";
import Blob from "cross-blob";

export interface ImageLocation {
	width : number,
	height : number,
	format : GsStorageFormat,
	/**
	 * Location of the image within GS memory, in units of 256 bytes
	 */
	location : number,
	is_clut : boolean
};

export class ImageChunk {
	/**
	 * 
	 * @param width Width in PSMCT32 format. Width is doubled in PSMT8 and PSMT4, and halved in CLUTs.
	 * @param height Height in PSMCT32 format. Height is doubled in PSMT8 and in CLUTS, and quadrupled in PSMT4. 
	 * @param data Image data in PSMCT32 format
	 * @param locations A list of locations within the image file
	 * @param base The default base address within the GS memory to write the image data to. Usually 0, but is set to 0x2a00 in fullscreen images and in the frontend data icon file.
	 */
	constructor(public width : number = 128, public height : number = 128, public locations : ImageLocation[] = [], public data : Uint8Array = new Uint8Array(width*height*4), public base = 0) {
		assert.strictEqual(width % 128, 0);
	}

	/**
	 * 
	 * @param where 
	 * @param swap_red_blue Only relevant in PSMCT32 - swaps between RGB and BGR
	 * @param fixup_alpha Only relevant in PSMCT32 - Remap alpha from 0x00-0x80 to 0x00-0xFF
	 * @returns 
	 */
	export_data(where : ImageLocation, swap_red_blue = false, fixup_alpha = false) : Uint8Array {
		if(where.format == GsStorageFormat.PSMCT32) {
			let [base_x, base_y] = deswizzle_32(where.location << 6, this.width / 64);
			let ptr = 0;
			let output = new Uint8Array(4 * where.width * where.height);
			let data_32 = new Uint32Array(this.data.buffer);
			let output_32 = new Uint32Array(output.buffer);
			for(let y = 0; y < where.height; y++) for(let x = 0; x < where.width; x++) {
				let data_word_address = (x+base_x) + (y+base_y) * this.width;
				output_32[ptr++] = data_32[data_word_address];
			}
			if(swap_red_blue) {
				for(let i = 0; i < output.length; i += 4) {
					let t = output[i];
					output[i] = output[i+2];
					output[i+2] = t;
				}
			}
			if(fixup_alpha) {
				for(let i = 0; i < output.length; i += 4) {
					output[i+3] = Math.round(Math.min(0xFF, output[i+3] / 0x80 * 0xFF));
				}
			}
			return where.is_clut ? swizzle_clut_buffer(output) : output;
		} else if(where.format == GsStorageFormat.PSMT8) {
			assert.strictEqual(where.is_clut, false);
			let width_1 = this.width / 64 * 2;
			let width_2 = this.width / 64;

			let ptr = 0;
			let output = new Uint8Array(where.width * where.height);
			for(let y = 0; y < where.height; y++) for(let x = 0; x < where.width; x++) {
				let byte_address = swizzle_8(x, y, width_1) + (256 * where.location);

				let [bx, by] = deswizzle_32(byte_address >> 2, width_2);
				let data_byte_address = (by * this.width + bx) * 4 + (byte_address & 3);
				output[ptr++] = this.data[data_byte_address];
			}
			return output;
		} else if(where.format == GsStorageFormat.PSMT4) {
			assert.strictEqual(where.is_clut, false);
			let width_1 = this.width / 64 * 2;
			let width_2 = this.width / 64;

			let ptr = 0;
			let output = new Uint8Array(where.width * where.height);
			for(let y = 0; y < where.height; y++) for(let x = 0; x < where.width; x++) {
				let halfbyte_address = swizzle_4(x, y, width_1) + (512 * where.location);

				let [bx, by] = deswizzle_32(halfbyte_address >> 3, width_2);
				let data_byte_address = (by * this.width + bx) * 4 + ((halfbyte_address >> 1) & 3);
				output[ptr++] = (this.data[data_byte_address] >> ((halfbyte_address & 1) << 2)) & 0xF;
			}
			return output;
		} else {
			throw new Error("Unsupported image format " + GsStorageFormat[where.format]);
		}
	}

	/**
	 * 
	 * @param where 
	 * @param input
	 * @param swap_red_blue Only relevant in PSMCT32 - swaps between RGB and BGR
	 * @param fixup_alpha Only relevant in PSMCT32 - Remap alpha from 0x00-0xFF to 0x00-0x80
	 * @returns 
	 */
	import_data(where : ImageLocation, input : Uint8Array, swap_red_blue = false, fixup_alpha = false) {
		if(where.format == GsStorageFormat.PSMCT32) {
			let [base_x, base_y] = deswizzle_32(where.location << 6, this.width / 64);
			if(where.is_clut) input = swizzle_clut_buffer(input, where.width*where.height*4);
			else if(swap_red_blue || fixup_alpha) input = input.slice();

			if(swap_red_blue) {
				for(let i = 0; i < input.length; i += 4) {
					let t = input[i];
					input[i] = input[i+2];
					input[i+2] = t;
				}
			}
			if(fixup_alpha) {
				for(let i = 0; i < input.length; i += 4) {
					input[i+3] = Math.round(input[i+3] / 0xFF * 0x80);
				}
			}

			let ptr = 0;
			let data_32 = new Uint32Array(this.data.buffer);
			let input_32 = new Uint32Array(input.buffer);
			for(let y = 0; y < where.height; y++) for(let x = 0; x < where.width; x++) {
				let data_word_address = (x+base_x) + (y+base_y) * this.width;
				data_32[data_word_address] = input_32[ptr++];
			}
		} else if(where.format == GsStorageFormat.PSMT8) {
			assert.strictEqual(where.is_clut, false);
			let width_1 = this.width / 64 * 2;
			let width_2 = this.width / 64;

			let ptr = 0;
			for(let y = 0; y < where.height; y++) for(let x = 0; x < where.width; x++) {
				let byte_address = swizzle_8(x, y, width_1) + (256 * where.location);

				let [bx, by] = deswizzle_32(byte_address >> 2, width_2);
				let data_byte_address = (by * this.width + bx) * 4 + (byte_address & 3);
				this.data[data_byte_address] = input[ptr++];
			}
		} else if(where.format == GsStorageFormat.PSMT4) {
			assert.strictEqual(where.is_clut, false);
			let width_1 = this.width / 64 * 2;
			let width_2 = this.width / 64;

			let ptr = 0;
			for(let y = 0; y < where.height; y++) for(let x = 0; x < where.width; x++) {
				let halfbyte_address = swizzle_4(x, y, width_1) + (512 * where.location);

				let [bx, by] = deswizzle_32(halfbyte_address >> 3, width_2);
				let data_byte_address = (by * this.width + bx) * 4 + ((halfbyte_address >> 1) & 3);

				this.data[data_byte_address] = this.data[data_byte_address]
					& ~(0xFFFF << ((halfbyte_address & 1) << 2))
					| (input[ptr++] << ((halfbyte_address & 1) << 2));
			}
		} else {
			throw new Error("Unsupported image format " + GsStorageFormat[where.format]);
		}
	}

	export_indexed_data(where : ImageLocation, clut : ImageLocation, swap_red_blue? : boolean, fixup_alpha? : boolean) : Uint8Array {
		if(where.format == GsStorageFormat.PSMCT32) return this.export_data(where, swap_red_blue, fixup_alpha);
		let indexed = this.export_data(where);
		let clut_data = new Int32Array(this.export_data(clut, swap_red_blue, fixup_alpha).buffer);
		let out_data = new Int32Array(indexed.length);
		for(let i = 0; i < indexed.length; i++) {
			out_data[i] = clut_data[indexed[i]];
		}
		return new Uint8Array(out_data.buffer);
	}

	static async from_blob(blob : Blob) : Promise<ImageChunk> {
		let data = new Uint8Array(await blob.arrayBuffer());
		let dv = new DataView(data.buffer);

		let meta_ptr = dv.getUint32(0, true);
		let data_ptr = dv.getUint32(4, true);
		// The two DMA buffers can be ignored when reading, as it's pretty much the same in all texture files
		// except for one specific unused texture file, and can be regenerated without too much hassle, and all
		// the information here is pretty much redundant.

		let size = dv.getUint32(meta_ptr + 20, true);
		
		let width = size & 0xFFF;
		let height = (size >> 12) & 0xFFF;

		let image_bytes = data.slice(data_ptr, data_ptr + width*height*4);

		let base_dbp = dv.getUint16(meta_ptr + 16, true);
		let base_width = dv.getUint8(meta_ptr + 18);

		let num_locations = dv.getUint32(meta_ptr + 8, true);

		let locations : ImageLocation[] = [];

		for(let i = 0; i < num_locations; i++) {
			let location_ptr = meta_ptr + 64 + i*48;
			let location_size = dv.getUint32(location_ptr + 4, true);
			let location_buffer_width = dv.getUint8(location_ptr + 2);

			let location_format = dv.getUint8(location_ptr + 7) as GsStorageFormat;
			locations.push({
				width: location_size & 0xFFF,
				height: (location_size >> 12) & 0xFFF,
				format: location_format,
				location: dv.getUint16(location_ptr, true) - base_dbp,
				is_clut: location_format == GsStorageFormat.PSMCT32 && location_buffer_width == base_width / 2
			});
		}

		return new ImageChunk(width, height, locations, image_bytes, base_dbp);
	}

	find_location(location_number : number) : ImageLocation|undefined {
		for(let location of this.locations) {
			if(location.location == location_number) return location;
		}
	}

	to_blob() : Blob {
		let dma_buffer = create_dma_buffer(this.width, this.height, this.base);
		let data = new Uint8Array(0x10 + dma_buffer.length * 2 + 0x40 + 0x30 * this.locations.length + this.data.length);
		let dv = new DataView(data.buffer);

		let dma1_ptr = 0x10;
		let dma2_ptr = dma1_ptr + dma_buffer.length;
		let meta_ptr = dma2_ptr + dma_buffer.length;
		let imagedata_ptr = meta_ptr + 0x40 + 0x30 * this.locations.length;
		dv.setUint32(0, meta_ptr, true);
		dv.setUint32(4, imagedata_ptr, true);
		dv.setUint32(8, dma1_ptr, true);
		dv.setUint32(12, dma2_ptr, true);

		data.set(dma_buffer, dma1_ptr);
		data.set(dma_buffer, dma2_ptr);
		data.set(this.data, imagedata_ptr);

		dv.setUint32(meta_ptr, 1, true);
		dv.setUint32(meta_ptr+4, 1, true);
		dv.setUint32(meta_ptr+8, this.locations.length, true);
		dv.setUint16(meta_ptr+16, this.base, true);
		data[meta_ptr+18] = this.width/64;
		dv.setUint32(meta_ptr+20, (this.width & 0xFFF) | ((this.height & 0xFFF) << 12), true);

		for(let i = 0; i < this.locations.length; i++) {
			let location = this.locations[i];
			let location_ptr = meta_ptr + 0x40 + 0x30*i;

			let buffer_width = this.width / 64;
			if(location.format == GsStorageFormat.PSMT4 || location.format == GsStorageFormat.PSMT8) buffer_width *= 2;
			else if(location.format == GsStorageFormat.PSMCT32 && location.is_clut) buffer_width /= 2;

			dv.setUint16(location_ptr, location.location, true);
			data[location_ptr+2] = buffer_width;
			dv.setUint32(location_ptr+4, (location.width & 0xFFF) | ((location.height & 0xFFF) << 12), true);
			data[location_ptr+7] = location.format;

			let reg_ptr = location_ptr+8;
			insert_bits(data, reg_ptr, 0, 14, location.location);
			insert_bits(data, reg_ptr, 14, 6, buffer_width);
			insert_bits(data, reg_ptr, 20, 6, location.format);
			insert_bits(data, reg_ptr, 26, 4, Math.ceil(Math.log2(location.width)));
			insert_bits(data, reg_ptr, 30, 4, Math.ceil(Math.log2(location.height)));
			insert_bits(data, reg_ptr, 34, 1, 1);
		}

		return new Blob([data]);
	}
}

function create_dma_buffer(width : number, height : number, base = 0) : Uint8Array {
	let transfer_height = Math.floor((0x7FFF * 4) / width);
	let num_transfers = Math.ceil(height / transfer_height);

	let data = new Uint8Array(0x80 * num_transfers + 0x30);
	let dv = new DataView(data.buffer);

	// The DMAC has a limit of 0x7FFF q-words per transfer, so
	// it needs to be split up into multiple transfers if there's
	// more than that.

	for(let i = 0; i < num_transfers; i++) {
		let transfer_ptr = i * 0x80;
		let this_transfer_y = i*transfer_height;
		let this_transfer_height = Math.min(transfer_height, height - transfer_height*i);
		let this_transfer_qwords = (this_transfer_height * width) / 4;
		let this_transfer_offset = (this_transfer_y * width) * 4;

		data[transfer_ptr+0x00] = 6;
		data[transfer_ptr+0x03] = 0x10;
		data[transfer_ptr+0x10] = 0x04;
		data[transfer_ptr+0x17] = 0x10;
		data[transfer_ptr+0x18] = 0x0e;

		dv.setUint16(transfer_ptr+0x24, base, true);
		data[transfer_ptr+0x26] = width / 64;
		data[transfer_ptr+0x28] = 0x50;

		dv.setUint16(transfer_ptr+0x36, this_transfer_y, true);
		data[transfer_ptr+0x38] = 0x51;

		dv.setUint16(transfer_ptr+0x40, width, true);
		dv.setUint16(transfer_ptr+0x44, this_transfer_height, true);
		data[transfer_ptr+0x48] = 0x52;

		data[transfer_ptr+0x58] = 0x53;

		dv.setUint16(transfer_ptr+0x60, this_transfer_qwords, true);
		data[transfer_ptr+0x67] = 0x08;
		dv.setUint16(transfer_ptr+0x70, this_transfer_qwords, true);
		data[transfer_ptr+0x73] = 0x30;
		dv.setUint32(transfer_ptr+0x74, this_transfer_offset, true);
	}

	let end_ptr = num_transfers*0x80;

	data[end_ptr+0x00] = 0x02;
	data[end_ptr+0x03] = 0x60;
	data[end_ptr+0x10] = 0x01;
	data[end_ptr+0x11] = 0x80;
	data[end_ptr+0x17] = 0x10;
	data[end_ptr+0x18] = 0x0e;
	data[end_ptr+0x28] = 0x3f;

	return data;
}
