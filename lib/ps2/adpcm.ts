const ADPCM_COEFFICIENTS = [
	[0,0],
	[60,0],
	[115,-52],
	[98,-55],
	[122,-60]
];

export function decode_adpcm(data : Uint8Array, p0 = 0, p1 = 0) {
	let end_offset = data.length;
	let loop_start = 0;
	let loop = false;
	// first lets figure out where the end point is.
	for(let i = 0; i < end_offset; i += 16) {
		if((data[i+1]) & 2) {
			loop = true;
			if((data[i+1]) & 4) {
				loop_start = (i / 16 * 28);
			}
		}
		if((data[i+1] & 1) || !((data[i+16] >> 4) <= 4)) {
			end_offset = i+16;
			break;
		}
	}
	end_offset = Math.floor(end_offset / 16) * 16
	// yeeted from here https://bitbucket.org/rerwarwar/gamestuff/src/default/JAD/vag.c
	let float_data = new Float32Array(end_offset / 16 * 28);
	for(let i = 0; i < end_offset; i += 16) {
		let shift = data[i] & 0xf;
		let index = data[i] >> 4;
		let c0 = ADPCM_COEFFICIENTS[index][0];
		let c1 = ADPCM_COEFFICIENTS[index][1];
		for(let j = 0; j < 28; j++) {
			let b = (j & 1) ? (data[i+2+(j>>1)] >> 4) : (data[i+2+(j>>1)] & 0xF);
			if(b > 7) b -= 16; // sign-extend the nibble
			let error = (b << 18) >> shift;
			let predicted = p0 * c0 + p1 * c1;
			p1 = p0;
			p0 = (error + predicted) >> 6
			float_data[((i) >> 4) * 28 + j] = p0 / 32768;
		}
	}
	return {
		float_data,
		loop_start : loop ? loop_start : undefined,
		p0, p1
	};
}

// Importing code - based on https://github.com/ColdSauce/psxsdk/blob/master/tools/wav2vag.c

type AdpcmAccum = {s1 : number, s2 : number, enc_s1 : number, enc_s2 : number};

export function encode_adpcm(data : Float32Array, loop_start? : number) : Uint8Array {
	let out_data = new Uint8Array(Math.ceil(data.length / 28 + 1) * 16);
	if(!out_data.length) return out_data;
	let in_ptr = 0, out_ptr = 0;
	let accum = {s1:0,s2:0, enc_s1:0, enc_s2:0};
	let loop_flag = false;
	while(in_ptr < data.length) {
		let {predict_nr, shift_factor, samples_out} = find_predict(data, in_ptr, accum);
		out_data[out_ptr] = (predict_nr << 4) | shift_factor;
		if(loop_start != undefined && in_ptr >= loop_start && !loop_flag) {
			out_data[out_ptr+1] |= 4;
		}
		if(loop_flag) out_data[out_ptr+1] |= 2;
		for(let i = 0; i < 28; i += 2) {
			out_data[out_ptr+2+(i>>1)] = (samples_out[i+1] << 4) | samples_out[i];
		}

		in_ptr += 28;
		out_ptr += 16;
	}
	out_data[out_data.length - 16 + 1] = loop_start != undefined ? (loop_flag ? 3 : 7) : 1;
	return out_data;
}

function find_predict(samples : Float32Array, samples_start : number, accum : AdpcmAccum) {
	let predict_nr = 0;
	let min = Infinity;
	let samples_out : number[] = [];
	let start_s1 = accum.s1;
	let start_s2 = accum.s2;
	for(let i = 0; i < 5; i++) {
		let max = 0;
		let s1 = start_s1;
		let s2 = start_s2;
		let buffer : number[] = [];
		for(let j = 0; j < 28; j++) {
			let s0 = samples[j+samples_start] ?? 0;
			if(s0 > 15/16) s0 = 15/16;
			if(s0 < -15/16) s0 = -15/16;
			let ds = s0 + s1 * -ADPCM_COEFFICIENTS[i][0]/64 + s2 * -ADPCM_COEFFICIENTS[i][1]/64;
			buffer.push(ds);
			max = Math.max(max, Math.abs(ds));
			s2 = s1;
			s1 = s0;
		}
		if(max < min) {
			min = max;
			samples_out = buffer;
			predict_nr = i;
			accum.s2 = s2;
			accum.s1 = s1;
		}
	}

	let min_int = Math.floor(min * 32767);
	let shift_mask = 0x4000;
	let shift_factor = 0;
	while(shift_factor < 12) {
		if(shift_mask & (min_int + (shift_mask >> 3))) break;
		shift_factor++;
		shift_mask = shift_mask >> 1;
	}
	let s1 = accum.enc_s1;
	let s2 = accum.enc_s2;
	for(let i = 0; i < 28; i++) {
		let s0 = samples_out[i] + s1 * -ADPCM_COEFFICIENTS[predict_nr][0]/64 + s2 * -ADPCM_COEFFICIENTS[predict_nr][1]/64;
		if(samples_start < 64) {
			console.log([s0, samples_out[i], samples[i+samples_start]]);
		}
		let ds = s0 * (1 << shift_factor) * 8;
		let di = Math.round(ds);
		if(di > 7) di = 7;
		if(di < -8) di = -8;
		samples_out[i] = di & 0xF;
		s2 = s1;
		s1 = ((di / (1 << shift_factor)) / 8) - s0;
	}
	accum.enc_s1 = s1;
	accum.enc_s2 = s2;

	return {predict_nr, shift_factor, samples_out};
}