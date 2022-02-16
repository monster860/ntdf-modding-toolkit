import assert from "assert";
import { decode_text, encode_text } from "../utils/text.js";
import Blob from "cross-blob";

export enum TableFieldType {
	String,
	Uint32,
	Int32,
	Uint16,
	Int16,
	Uint8,
	Int8,
	Float
};

type TableField<T extends TableFieldType> = T extends TableFieldType.String ? string|null : number;

export type TableRowOf<T extends readonly TableFieldType[]> = {
	-readonly [P in keyof T]: T[P] extends TableFieldType ? TableField<T[P]> : never
}

export class TableChunk<T extends readonly TableFieldType[] = TableFieldType[]> {
	constructor(public readonly format : T, public entries : TableRowOf<T>[]) {
	}

	static async from_blob<T extends readonly TableFieldType[]>(blob : Blob, format : T) : Promise<TableChunk<T>> {
		let dv = new DataView(await blob.arrayBuffer());
		let entry_size = dv.getUint16(14, true);
		let entry_count = dv.getUint16(12, true);
		let entries : TableRowOf<T>[] = [];
		
		assert.strictEqual(entry_size, TableChunk.get_format_size(format));
		for(let i = 0; i < entry_count; i++) {
			let entry : Array<number|string|null> = [];
			let ptr = 0x10 + entry_size*i;
			for(let item of format) {
				let item_length : number;
				switch(item) {
					case TableFieldType.Uint16:
					case TableFieldType.Int16:
						item_length = 2;
						break;
					case TableFieldType.Uint8:
					case TableFieldType.Int8:
						item_length = 1;
						break;
					default:
						item_length = 4;
				}
				ptr = Math.ceil(ptr / item_length) * item_length;
				switch(item) {
					case TableFieldType.String:
						let string_ptr = dv.getUint32(ptr, true);
						entry.push(string_ptr == 0 ? null : decode_text(new Uint8Array(dv.buffer, string_ptr)));
						break;
					case TableFieldType.Uint32:
						entry.push(dv.getUint32(ptr, true));
						break;
					case TableFieldType.Int32:
						entry.push(dv.getInt32(ptr, true));
						break;
					case TableFieldType.Uint16:
						entry.push(dv.getUint16(ptr, true));
						break;
					case TableFieldType.Int16:
						entry.push(dv.getInt16(ptr, true));
						break;
					case TableFieldType.Uint8:
						entry.push(dv.getUint8(ptr));
						break;
					case TableFieldType.Int8:
						entry.push(dv.getInt8(ptr));
						break;
					case TableFieldType.Float:
						entry.push(dv.getFloat32(ptr, true));
						break;
				}
				ptr += item_length;
			}
			entries.push(entry as unknown as TableRowOf<T>);
		}
		return new TableChunk(format, entries);
	}

	to_blob() : Blob {
		let format_size = TableChunk.get_format_size(this.format);
		let string_table_start = this.entries.length * format_size + 0x10;
		let string_table_ptr = string_table_start;
		let string_addresses = new Map<string, number>();
		let string_table_list : Uint8Array[] = [];

		for(let entry of this.entries) for(let item of entry) {
			if(typeof item == "string") {
				let array = encode_text(item);
				let normalized = decode_text(array);
				if(!string_addresses.has(normalized)) {
					string_addresses.set(normalized, string_table_ptr);
					string_table_list.push(array);
					string_table_ptr += array.length+1;
				}
				let addr = string_addresses.get(normalized);
				assert(addr != undefined);
				string_addresses.set(item, addr);
			}
		}

		let output = new Uint8Array(Math.ceil(string_table_ptr / 4) * 4);
		let dv = new DataView(output.buffer);

		output.set([0x49, 0x44, 0x4d, 0x58, 0x4c], 0);
		dv.setUint32(8, string_table_start, true);
		dv.setUint16(12, this.entries.length, true);
		dv.setUint16(14, format_size, true);
		
		string_table_ptr = string_table_start;
		for(let array of string_table_list) {
			output.set(array, string_table_ptr);
			string_table_ptr += array.length + 1;
		}

		for(let i = 0; i < this.entries.length; i++) {
			assert.strictEqual(this.entries[i].length, this.format.length);
			let entry = this.entries[i];
			let ptr = 0x10 + format_size*i;
			for(let j = 0; j < this.format.length; j++) {
				let item_length : number;
				let format_item = this.format[j];
				switch(format_item) {
					case TableFieldType.Uint16:
					case TableFieldType.Int16:
						item_length = 2;
						break;
					case TableFieldType.Uint8:
					case TableFieldType.Int8:
						item_length = 1;
						break;
					default:
						item_length = 4;
				}
				ptr = Math.ceil(ptr / item_length) * item_length;
				let item = entry[j];
				if(format_item == TableFieldType.String) {
					assert(typeof item == "string" || item == null);
					let string_ptr = item == null ? 0 : string_addresses.get(item);
					assert(string_ptr != undefined);
					dv.setUint32(ptr, string_ptr, true);
				} else {
					assert(typeof item == "number");
					switch(format_item) {
						case TableFieldType.Uint32:
							dv.setUint32(ptr, item, true);
							break;
						case TableFieldType.Int32:
							dv.setInt32(ptr, item, true);
							break;
						case TableFieldType.Uint16:
							dv.setUint16(ptr, item, true);
							break;
						case TableFieldType.Int16:
							dv.setInt16(ptr, item, true);
							break;
						case TableFieldType.Uint8:
							dv.setUint8(ptr, item);
							break;
						case TableFieldType.Int8:
							dv.setInt8(ptr, item);
							break;
						case TableFieldType.Float:
							dv.setFloat32(ptr, item, true);
							break;
					}
				}
				ptr += item_length;
			}
		}

		return new Blob([output]);
	}

	static get_format_size(format : readonly TableFieldType[]) : number {
		let alignment = 0;
		let length = 0;
		for(let item of format) {
			let item_length : number;
			switch(item) {
				case TableFieldType.Uint16:
				case TableFieldType.Int16:
					item_length = 2;
					break;
				case TableFieldType.Uint8:
				case TableFieldType.Int8:
					item_length = 1;
					break;
				default:
					item_length = 4;
			}
			alignment = Math.max(alignment, item_length);
			length = Math.ceil(length / item_length) * item_length
			length += item_length;
		}
		length = Math.ceil(length / alignment) * alignment;
		return length;
	}
}

export namespace TableFormats {
	export const string_table = [
		TableFieldType.String
	];
	/**
	 * used by table 0
	 */
	export const item_table = [
		TableFieldType.String,
		TableFieldType.Int32,
		TableFieldType.Int32,
		TableFieldType.Int32,
		TableFieldType.Int32,
		TableFieldType.Int32,
		TableFieldType.Int32,
		TableFieldType.Int16, TableFieldType.Uint8, TableFieldType.Uint8,
		TableFieldType.String,
		TableFieldType.String,
		TableFieldType.String,
		TableFieldType.String,
		TableFieldType.String
	] as const;
	/**
	 * used by tables in files of type 1000
	 */
	export const dialogue_table = [
		TableFieldType.String,
		TableFieldType.String,
		TableFieldType.Uint32
	] as const;

	export const world_info = [
		TableFieldType.Int32,
		TableFieldType.Int32,
		TableFieldType.Int32,
		TableFieldType.Int32,
		TableFieldType.Int32,
	] as const;
}
