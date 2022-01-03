import assert from "assert";

export enum VifCodeType {
	NOP = 0,
	STCYCL = 0b1,
	OFFSET = 0b10,
	BASE = 0b11,
	ITOP = 0b100,
	STMOD = 0b101,
	MSKPATH3 = 0b110,
	MARK = 0b111,
	FLUSHE = 0b10000,
	FLUSH = 0b10001,
	FLUSHA = 0b10011,
	MSCAL = 0b10100,
	MSCNT = 0b10111,
	MSCALF = 0b10101,
	STMASK = 0b100000,
	STROW = 0b110000,
	STCOL = 0b110001,
	MPG = 0b1001010,
	DIRECT = 0b1010000,
	DIRECTHL = 0b1010001,
	UNPACK = 0b1100000
};

interface VifCodeBase {
	type : VifCodeType;
	interrupt : boolean;
};

export interface VifCodeSimple extends VifCodeBase {
	type : Exclude<VifCodeType, VifCodeType.STMASK | VifCodeType.STROW | VifCodeType.STCOL | VifCodeType.MPG | VifCodeType.DIRECT | VifCodeType.DIRECTHL | VifCodeType.UNPACK>;
	num: number;
	immediate: number;
}

export interface VifCodeStMask extends VifCodeBase {
	type : VifCodeType.STMASK;
	mask : number;
}

export interface VifCodeStRowCol extends VifCodeBase {
	type : VifCodeType.STROW | VifCodeType.STCOL;
	filling_data : [number,number,number,number];
}

export interface VifCodeDirect extends VifCodeBase {
	type : VifCodeType.DIRECT | VifCodeType.DIRECTHL;
	data : ArrayBuffer;
}

export interface VifCodeMpg extends VifCodeBase {
	type : VifCodeType.MPG;
	loadaddr : number;
	data : ArrayBuffer;
}

export interface VifCodeUnpack extends VifCodeBase {
	type : VifCodeType.UNPACK;
	masked : boolean;
	location : number;
	num : number;
	use_tops : boolean;
	unsigned : boolean;
	vn : number;
	vl : number;
	data : ArrayBuffer;
}

export type VifCode = VifCodeSimple|VifCodeStMask|VifCodeStRowCol|VifCodeDirect|VifCodeMpg|VifCodeUnpack;

export function read_vif_code(dv : DataView, pointer = 0, length? : number) : VifCode[] {
	pointer = pointer &= ~3;
	let end = (length != undefined) ? pointer+length : dv.byteLength;
	let array : VifCode[] = [];
	while(pointer < end) {
		let cmd = dv.getUint8(pointer+3);
		let num = dv.getUint8(pointer+2);
		let immediate = dv.getUint16(pointer, true);
		pointer += 4;
		let interrupt = !!(cmd & 0x80);
		let type : VifCodeType = ((cmd & VifCodeType.UNPACK) == VifCodeType.UNPACK) ? VifCodeType.UNPACK : (cmd & 0x7F)
		if(type == VifCodeType.UNPACK) {
			let masked = !!((cmd >> 4) & 1);
			let location = immediate & 0x3FFF;
			let unsigned = !!(immediate & 0x4000);
			let use_tops = !!(immediate & 0x8000);
			let vl = cmd & 3;
			let vn = (cmd >> 2) & 3;

			let bytes = (((8>>vl) * (vn+1)) >> 1) * num;
			let data = dv.buffer.slice(pointer + dv.byteOffset, pointer+dv.byteOffset+bytes);
			pointer += Math.ceil(bytes/4)*4;
			array.push({
				type, interrupt,
				masked, location, num,
				use_tops, unsigned, vn, vl,
				data
			});
		} else if(type == VifCodeType.DIRECT || type == VifCodeType.DIRECTHL) {
			let qwords = ((immediate - 1) & 0xFFFF) + 1;
			let data = dv.buffer.slice(pointer + dv.byteOffset, pointer+dv.byteOffset + qwords*0x10);
			pointer += qwords*0x10;
			array.push({type, interrupt, data});
		} else if(type == VifCodeType.STMASK) {
			let mask = dv.getUint32(pointer, true);
			pointer += 4;
			array.push({type, interrupt, mask});
		} else if(type == VifCodeType.STROW || type == VifCodeType.STCOL) {
			let filling_data : [number,number,number,number] = [
				dv.getUint32(pointer, true),
				dv.getUint32(pointer+4, true),
				dv.getUint32(pointer+8, true),
				dv.getUint32(pointer+12, true),
			];
			pointer += 16;
			array.push({type, interrupt, filling_data});
		} else if(type == VifCodeType.MPG) {
			let size = ((num - 1) & 0xFF) + 1;
			let data = dv.buffer.slice(pointer + dv.byteOffset, pointer + dv.byteOffset + size*8);
			pointer += size*8;
			array.push({type, interrupt, data, loadaddr: immediate});
		} else {
			array.push({type, interrupt, num, immediate});
		}
	}
	return array;
}

export function write_vif_code(vif_code : VifCode[]) : ArrayBuffer {
	let length = 0;
	for(let item of vif_code) {
		length += 4;
		if(item.type == VifCodeType.MPG) {
			assert.strictEqual(item.data.byteLength % 8, 0);
			length += item.data.byteLength;
		} else if(item.type == VifCodeType.STROW || item.type == VifCodeType.STCOL) {
			length += 16;
		} else if(item.type == VifCodeType.STMASK) {
			length += 4;
		} else if(item.type == VifCodeType.DIRECT || item.type == VifCodeType.DIRECTHL) {
			assert.strictEqual(item.data.byteLength % 16, 0);
			length += item.data.byteLength;
		} else if(item.type == VifCodeType.UNPACK) {
			let bytes = (((8>>item.vl) * (item.vn+1)) >> 1) * item.num;
			assert.strictEqual(bytes, item.data.byteLength);
			length += Math.ceil(bytes/4)*4;
		}
	}
	let dv = new DataView(new ArrayBuffer(length));
	let data = new Uint8Array(dv.buffer);
	let ptr = 0;
	for(let item of vif_code) {
		let cmd = 0;
		if(item.interrupt) cmd |= 0x80;
		cmd |= item.type;

		let num = 0;
		let immediate = 0;
		let vifcode_ptr = ptr;

		ptr += 4;
		if(item.type == VifCodeType.MPG) {
			num = (item.data.byteLength / 8) & 0xFF
			immediate = item.loadaddr;
			data.set(new Uint8Array(item.data), ptr);
			ptr += item.data.byteLength;
		} else if(item.type == VifCodeType.STROW || item.type == VifCodeType.STCOL) {
			dv.setUint32(ptr, item.filling_data[0], true);
			dv.setUint32(ptr+4, item.filling_data[1], true);
			dv.setUint32(ptr+8, item.filling_data[2], true);
			dv.setUint32(ptr+12, item.filling_data[3], true);
			ptr += 16;
		} else if(item.type == VifCodeType.STMASK) {
			dv.setUint32(ptr, item.mask, true);
			ptr += 4;
		} else if(item.type == VifCodeType.DIRECT || item.type == VifCodeType.DIRECTHL) {
			immediate = (item.data.byteLength / 16) & 0xFFFF
			data.set(new Uint8Array(item.data), ptr);
			ptr += item.data.byteLength;
		} else if(item.type == VifCodeType.UNPACK) {
			cmd |= (item.vl) | (item.vn << 2);
			if(item.masked) cmd |= 0x10;
			num = item.num;
			immediate = item.location
			if(item.use_tops) immediate |= 0x8000;
			if(item.unsigned) immediate |= 0x4000;
			data.set(new Uint8Array(item.data), ptr);
			ptr += Math.ceil(item.data.byteLength/4)*4;
		} else {
			item = item as VifCodeSimple; // wtf typescript
			num = item.num;
			immediate = item.immediate;
		}
		data[vifcode_ptr+3] = cmd;
		data[vifcode_ptr+2] = num;
		dv.setUint16(vifcode_ptr, immediate, true);
	}
	return data.buffer;
}
