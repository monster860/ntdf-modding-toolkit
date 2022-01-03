export function deswizzle_32(word_addr : number, buffer_width : number) : [number, number] {
	let page = word_addr >> 11;
	let block = (word_addr >> 6) & 0b11111;
	let column = (word_addr >> 4) & 0b11;
	let within_column = word_addr & 0b1111;

	let x = (page % buffer_width) * 64;
	let y = Math.floor(page / buffer_width) * 32;
	
	x |= ((block & 1) << 3) | ((block & 4) << 2) | ((block & 16) << 1);
	y |= ((block & 2) << 2) | ((block & 8) << 1);

	y |= (column << 1);

	x |= (within_column & 1) | ((within_column & 12) >> 1);
	y |= (within_column & 2) >> 1;

	return [x,y];
}

export function swizzle_32(x : number, y : number, buffer_width : number) : number {
	let page = (Math.floor(x / 64) + Math.floor(y / 32) * buffer_width);
	let block = ((x & 8) >> 3) | ((x & 16) >> 2) | ((x & 32) >> 1) | ((y & 8) >> 2) | ((y & 16) >> 1);
	let column = (y & 6) >> 1;
	let within_column = (x & 1) | ((x & 6) << 1) | ((y & 1) << 1);

	return (page << 11) | (block << 6) | (column << 4) | within_column;
}


export function deswizzle_8(byte_addr : number, buffer_width : number) : [number, number] {
	let page = byte_addr >> 13;
	let block = (byte_addr >> 8) & 0b11111;
	let column = (byte_addr >> 6) & 0b11;
	let within_column = byte_addr & 0b111111;

	buffer_width /= 2;
	let x = (page % buffer_width) * 128;
	let y = Math.floor(page / buffer_width) * 64;

	x |= ((block & 1) << 4) | ((block & 4) << 3) | ((block & 16) << 2);
	y |= ((block & 2) << 3) | ((block & 8) << 2);

	y |= (column << 2);

	x |= ((within_column & 4) >> 2) | ((within_column & 16) >> 3) | (((within_column & 32) >> 3) ^ ((column & 1) << 2) ^ ((within_column & 1) << 2)) | ((within_column & 2) << 2);
	y |= ((within_column & 8) >> 3) | ((within_column & 1) << 1);

	return [x,y];
}

export function swizzle_8(x : number, y : number, buffer_width : number) {
	buffer_width /= 2;
	let page = (Math.floor(x / 128) + Math.floor(y / 64) * buffer_width);
	let block = ((x & 16) >> 4) | ((x & 32) >> 3) | ((x & 64) >> 2) | ((y & 16) >> 3) | ((y & 32) >> 2);
	let column = (y >> 2) & 3;
	let within_column = ((x & 1) << 2) | ((x & 2) << 3) | ((y & 1) << 3) | ((y & 2) >> 1) | (((x & 4) << 3) ^ ((column & 1) << 5) ^ ((y & 2) << 4)) | ((x & 8) >> 2);

	return (page << 13) | (block << 8) | (column << 6) | within_column;
}

export function deswizzle_4(halfbyte_addr : number, buffer_width : number) : [number,number] {
	let page = halfbyte_addr >> 14;
	let block = (halfbyte_addr >> 9) & 0b11111;
	let column = (halfbyte_addr >> 7) & 0b11;
	let within_column = halfbyte_addr & 0b1111111;

	buffer_width /= 2;
	let x = (page % buffer_width) * 128;
	let y = Math.floor(page / buffer_width) * 128;

	x |= ((block & 2) << 4) | ((block & 8) << 3);
	y |= ((block & 1) << 4) | ((block & 4) << 3) | ((block & 16) << 2);

	y |= (column << 2);

	x |= ((within_column & 8) >> 3) | ((within_column & 32) >> 4) | (((within_column & 64) >> 4) ^ ((within_column & 1) << 2) ^ ((column & 1) << 2)) | ((within_column & 6) << 2);
	y |= ((within_column & 16) >> 4) | ((within_column & 1) << 1);

	return [x, y];
}

export function swizzle_4(x : number, y : number, buffer_width : number) {
	buffer_width /= 2;
	let page = (Math.floor(x / 128) + Math.floor(y / 128) * buffer_width);
	let block = ((x & 32) >> 4) | ((x & 64) >> 3) | ((y & 16) >> 4) | ((y & 32) >> 3) | ((y & 64) >> 2);
	let column = (y >> 2) & 3;
	let within_column = ((x & 1) << 3) | ((x & 2) << 4) | (((x & 4) << 4) ^ ((column & 1) << 6) ^ ((y & 2) << 5)) | ((x & 24) >> 2) | ((y & 1) << 4) | ((y & 2) >> 1);

	return (page << 14) | (block << 9) | (column << 7) | within_column;
}

export function swizzle_clut(index : number) : number {
	return (index & 0xE7) | ((index & 0x10) >> 1) | ((index & 0x8) << 1)
}

export function swizzle_clut_buffer(buffer : Uint8Array, buffer_length = buffer.length) : Uint8Array {
	if(buffer_length == 32 || buffer_length == 64) return buffer.slice();
	if(buffer_length == 1024) {
		let buffer_32 = new Uint32Array(buffer.buffer);
		let output_32 = new Uint32Array(256);

		for(let i = 0; i < 256; i++) output_32[i] = buffer_32[swizzle_clut(i)] ?? 0;

		return new Uint8Array(output_32.buffer);
	} else if(buffer_length == 512) {
		let buffer_16 = new Uint16Array(buffer.buffer);
		let output_16 = new Uint16Array(256);

		for(let i = 0; i < 256; i++) output_16[i] = buffer_16[swizzle_clut(i)] ?? 0;

		return new Uint8Array(output_16.buffer);
	} else {
		throw new Error("Unsupported CLUT size of " + buffer_length + " bytes");
	}
}
