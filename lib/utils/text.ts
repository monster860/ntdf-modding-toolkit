const decoder = new TextDecoder('windows-1252');

let mapping_array = new Uint8Array(256);
for(let i = 0; i < 256; i++) mapping_array[i] = i;
let mapping_string = decoder.decode(mapping_array);

let encode_mapping = new Map<number,number>();
for(let i = 0; i < 256; i++) {
	encode_mapping.set(mapping_string.charCodeAt(i), i);
}

const MACRO_FLAG_DISPLAY = 1;
const MACRO_FLAG_ACTION = 2;
const MACRO_FLAG_MARKER = 4;
const MACRO_FLAG_FLAGS = 8;
const MACRO_FLAG_GIVE = 16;

const macro_names = new Map<string,number>([
	["color", 2],
	["next", 4],
	["emote", 16],
	["set_flags", 17],
	["clear_flags", 18],
	["give", 19],
	["set_dialog_camera", 21],
	["hero_emote", 23],
	["set_game_stage", 25],
	["hero_speaker", 32],
	["placeholder", 33],
	["reset_speaker", 34],
]);
const macro_default_flags = new Map<number,number>([
	[2, MACRO_FLAG_DISPLAY],
	[4, MACRO_FLAG_MARKER],
	[17, MACRO_FLAG_FLAGS|MACRO_FLAG_ACTION],
	[18, MACRO_FLAG_FLAGS|MACRO_FLAG_ACTION],
	[19, MACRO_FLAG_GIVE|MACRO_FLAG_ACTION],
	[33, MACRO_FLAG_MARKER],
])
const macro_names_reverse = new Map<number, string>([...macro_names].map(a => [a[1],a[0]]));

export function encode_text(text : string) : Uint8Array {
	let encoded_array : number[] = [];
	for(let i = 0; i < text.length; i++) {
		if(text[i] == "[") {
			let macro_start = ++i;
			while(text[i] && text[i] != "<" && text[i] != "(" && text[i] != "]") {
				i++;
			}
			let macro_end = i;
			let arguments_arr = [];
			let flags_override : number|undefined = undefined;
			if(text[i] == "<") {
				flags_override = 0;
				let flags_start = ++i;
				while(text[i] && text[i] != ">") i++;
				let flags_end = i++;
				let flags_split = text.substring(flags_start, flags_end).split("|");
				for(let flag_str of flags_split) {
					if(flag_str == "display") {
						flags_override |= MACRO_FLAG_DISPLAY;
					} else if(flag_str == "marker") {
						flags_override |= MACRO_FLAG_MARKER;
					} else if(flag_str == "action") {
						flags_override |= MACRO_FLAG_ACTION;
					} else if(flag_str == "flags") {
						flags_override |= MACRO_FLAG_FLAGS;
					} else if(flag_str == "give") {
						flags_override |= MACRO_FLAG_GIVE;
					} else {
						flags_override |= +flag_str;
					}
				}
				flags_override &= 0x7F;
			}
			if(text[i] == "(") {
				let arguments_start = ++i;
				while(text[i] && text[i] != ")") i++;
				let arguments_end = i++;
				arguments_arr = JSON.parse("[" + text.substring(arguments_start, arguments_end) + "]");
			}
			while(text[i] && text[i] != "]") i++;
			let macro_name = text.substring(macro_start, macro_end);
			if(macro_name == "triangle") {
				encoded_array.push('@'.charCodeAt(0));
			} else if(macro_name == "circle") {
				encoded_array.push('#'.charCodeAt(0));
			} else if(macro_name == "cross") {
				encoded_array.push("^".charCodeAt(0));
			} else if(macro_name == "square") {
				encoded_array.push("~".charCodeAt(0));
			} else if(macro_name == "start") {
				encoded_array.push("=".charCodeAt(0));
			} else if(macro_name == "select") {
				encoded_array.push("_".charCodeAt(0));
			} else {
				let macro_number = 0;
				if(macro_name.startsWith("macro")) macro_number = +macro_name.substring(5);
				else {
					macro_number = macro_names.get(macro_name) ?? 0;
				}
				if(!macro_number || macro_number < 2 || macro_number >= 256) throw new Error("Unknown text macro " + macro_name + " in string " + text);
				let flags = flags_override ?? (macro_default_flags.get(macro_number) ?? MACRO_FLAG_ACTION);
				if(arguments_arr.length > 2) throw new Error("Macro has " + arguments_arr.length + " arguments which has more than 2 (which can crash the game) in string " + text);
				encoded_array.push(1);
				encoded_array.push(arguments_arr.length + 2);
				let length_measure_mark = encoded_array.length;
				encoded_array.push(2);
				encoded_array.push(macro_number);
				encoded_array.push(flags + 2);
				for(let arg of arguments_arr) {
					let as_array : number[];
					if(arg instanceof Array) {
						as_array = [
							arg[0] & 0xFF,
							arg[1] & 0xFF,
							arg[2] & 0xFF,
							arg[3] & 0xFF
						];
					} else {
						let num = +arg;
						as_array = [
							(num) & 0xFF,
							(num >> 8) & 0xFF,
							(num >> 16) & 0xFF,
							(num >> 24) & 0xFF
						];
					}
					for(let item of as_array) {
						if(item < 0x21) {
							encoded_array.push(0xFD);
							encoded_array.push(item + 0x40)
						} else if(item == 0xFD) {
							encoded_array.push(0xFD);
							encoded_array.push(2);
						} else {
							encoded_array.push(item);
						}
					}
				}
				encoded_array[length_measure_mark] = encoded_array.length - length_measure_mark + 2;
			}
		} else {
			let encoded_char = encode_mapping.get(text.charCodeAt(i));
			if(!encoded_char) throw new Error("Bad character!");
			encoded_array.push(encoded_char);
		}
	}
	return new Uint8Array(encoded_array);
}

export function decode_text(arr : Uint8Array) : string {
	let string = "";
	for(let i = 0; i < arr.length; i++) {
		if(arr[i] == 0) break;
		else if(arr[i] == 1) {
			let macro_number = arr[i+3];
			let num_arguments = arr[i+1]-2;
			let flags = (arr[i+4]-2) & 0x7F;
			i += 5;
			string += "[";
			let name_str = macro_names_reverse.get(macro_number) ?? ("macro"+macro_number)
			string += name_str;
			let default_flags = macro_default_flags.get(macro_number) ?? MACRO_FLAG_ACTION;
			if(default_flags != flags) {
				let flag_parts : string[] = [];
				if(flags & MACRO_FLAG_DISPLAY) flag_parts.push("display");
				if(flags & MACRO_FLAG_ACTION) flag_parts.push("action");
				if(flags & MACRO_FLAG_MARKER) flag_parts.push("marker");
				if(flags & MACRO_FLAG_FLAGS) flag_parts.push("flags");
				if(flags & MACRO_FLAG_GIVE) flag_parts.push("give");
				if(flags & ~7) flag_parts.push((flags & ~7).toString());
				string += "<" + flag_parts.join("|") + ">";
			}
			let arg_strings : string[] = [];
			for(let j = 0; j < num_arguments; j++) {
				let arg_array : number[] = [];
				for(let k = 0; k < 4; k++) {
					let first = arr[i++];
					if(first == 0xFD) {
						let second = arr[i++];
						if(second == 2) arg_array.push(0xFD);
						else if(((second - 0x40) & 0xFF) < 0x21) arg_array.push((second - 0x40) & 0xFF);
						else arg_array.push(0);
					} else {
						arg_array.push(first);
					}
				}
				if(macro_number == 2) {
					arg_strings.push(JSON.stringify(arg_array));
				} else {
					arg_strings.push("" + (
						(arg_array[0] & 0xFF)
						| ((arg_array[1] & 0xFF) << 8)
						| ((arg_array[2] & 0xFF) << 16)
						| ((arg_array[3] & 0xFF) << 24)
					));
				}
			}
			if(arg_strings.length) {
				string += "(" + arg_strings.join(",") + ")";
			}
			string += "]";
			i--;
		} else {
			let char = mapping_string[arr[i]];
			if(char == '@') string += "[triangle]";
			else if(char == '#') string += "[circle]";
			else if(char == '^') string += "[cross]";
			else if(char == '~') string += "[square]";
			else if(char == "=") string += "[start]";
			else if(char == "_") string += "[select]";
			else string += char;
		}
	}
	return string;
}
