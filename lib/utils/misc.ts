function make_mask(num_bits : number) {
    if(num_bits >= 32) return -1;
    return ((1 << num_bits) - 1);
}

export function extract_bits(data : Uint8Array, offset : number, shift : number, num_bits : number) : number {
	while(shift >= 8) {
		shift -= 8;
		offset++
	}
	let output_shift = 0;
	let output_number = 0;
	let bytes = Math.ceil((shift + num_bits) / 8)
	for(let i = 0; i < bytes; i++) {
		output_number |= ((data[offset + i] >> shift) & make_mask(8 - shift)) << output_shift;
		output_shift += 8 - shift;
		shift = 0;
	}
	return output_number & make_mask(num_bits);
}

export function insert_bits(data : Uint8Array, offset : number, shift : number, num_bits : number, number : number) {
	while(shift >= 8) {
		shift -= 8;
		offset++
	}
	number &= make_mask(num_bits);
	let bytes = Math.ceil((shift + num_bits) / 8)
	for(let i = 0; i < bytes; i++) {
		data[offset + i] = (data[offset + i] & (make_mask(shift) | ~make_mask(shift + num_bits))) | ((number << shift) & 0xFF);
		number >>>= (8 - shift);
		shift = 0;
	}
}

export function srgb_to_linear(c : number) {
	if(c < 0.04045) {
		return Math.max(0, c / 12.92);
	} else {
		return ((c + 0.055) / 1.055)**2.4;
	}
}

export function linear_to_srgb(c : number) {
	if(c < 0.0031308) {
		return Math.max(0, c * 12.92);
	} else {
		return 1.055 * (c ** (1/2.4)) - 0.055;
	}
}

export function cross_product(a : Vec3, b : Vec3) : Vec3 {
	return [
		a[1] * b[2] - b[1] * a[2],
		b[0] * a[2] - a[0] * b[2],
		a[0] * b[1] - b[0] * a[1]
	]
}

export type Matrix = [number,number,number,number,number,number,number,number,number,number,number,number,number,number,number,number];
export type Vec3 = [number,number,number];
export type Vec4 = [number,number,number,number];

export function triangle_normal(a : Vec3, b : Vec3, c : Vec3) {
	let vec = cross_product(
		[
			b[0]-a[0], b[1]-a[1], b[2]-a[2]
		],
		[
			c[0]-a[0], c[1]-a[1], c[2]-a[2]
		]
	);
	let inv_magnitude = 1 / Math.sqrt(vec[0]*vec[0] + vec[1]*vec[1] + vec[2]*vec[2]);
	vec[0] *= inv_magnitude;
	vec[1] *= inv_magnitude;
	vec[2] *= inv_magnitude;
	return vec;
}

export function matrix_multiply(a : Matrix, b : Matrix) {
	let new_matrix : Matrix = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
	for(let i = 0; i < 4; i++) {
		for(let j = 0; j < 4; j++) {
			let sum = 0;
			for(let k = 0; k < 4; k++) {
				sum += a[i*4+k] * b[k*4+j];
			}
			new_matrix[i*4+j] = sum;
		}
	}
	return new_matrix;
}

export function transform_to_matrix(translation? : Vec3, rotation? : Vec4, scale? : Vec3) : Matrix {
	let new_matrix : Matrix = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
	if(translation) {
		new_matrix[12] = translation[0];
		new_matrix[13] = translation[1];
		new_matrix[14] = translation[2];
	}
	if(rotation) {
		new_matrix[0] = 1 - 2*rotation[1]**2 - 2*rotation[2]**2;
		new_matrix[4] = 2*rotation[0]*rotation[1] - 2*rotation[2]*rotation[3];
		new_matrix[8] = 2*rotation[0]*rotation[2] + 2*rotation[1]*rotation[3];
		new_matrix[1] = 2*rotation[0]*rotation[1] + 2*rotation[2]*rotation[3];
		new_matrix[5] = 1 - 2*rotation[0]**2 - 2*rotation[2]**2;
		new_matrix[9] = 2*rotation[1]*rotation[2] - 2*rotation[0]*rotation[3];
		new_matrix[2] = 2*rotation[0]*rotation[2] - 2*rotation[1]*rotation[3];
		new_matrix[6] = 2*rotation[1]*rotation[2] + 2*rotation[0]*rotation[3];
		new_matrix[10] = 1 - 2*rotation[0]**2 - 2*rotation[1]**2;
	}
	if(scale) {
		new_matrix[0] *= scale[0]; new_matrix[1] *= scale[0]; new_matrix[2] *= scale[0];
		new_matrix[4] *= scale[1]; new_matrix[5] *= scale[1]; new_matrix[6] *= scale[1];
		new_matrix[8] *= scale[2]; new_matrix[9] *= scale[2]; new_matrix[10] *= scale[2];
	}
	return new_matrix;
}

export function apply_matrix(mat : Matrix, vec : Vec3, include_translate : boolean = true) : Vec3 {
	let w = include_translate ? 1 : 0;
	return [
		mat[0]*vec[0] + mat[4]*vec[1] + mat[8]*vec[2] + mat[12]*w,
		mat[1]*vec[0] + mat[5]*vec[1] + mat[9]*vec[2] + mat[13]*w,
		mat[2]*vec[0] + mat[6]*vec[1] + mat[10]*vec[2] + mat[14]*w
	];
}

export function matrix_inverse(mat : Matrix) : Matrix|null {
	// https://github.com/matthiasferch/tsm/blob/d927fd5c197928123b6c1a3ccedfc64a3d43527c/src/mat4.ts#L164
	const a00 = mat[0];
	const a01 = mat[1];
	const a02 = mat[2];
	const a03 = mat[3];
	const a10 = mat[4];
	const a11 = mat[5];
	const a12 = mat[6];
	const a13 = mat[7];
	const a20 = mat[8];
	const a21 = mat[9];
	const a22 = mat[10];
	const a23 = mat[11];
	const a30 = mat[12];
	const a31 = mat[13];
	const a32 = mat[14];
	const a33 = mat[15];

	const det00 = a00 * a11 - a01 * a10;
	const det01 = a00 * a12 - a02 * a10;
	const det02 = a00 * a13 - a03 * a10;
	const det03 = a01 * a12 - a02 * a11;
	const det04 = a01 * a13 - a03 * a11;
	const det05 = a02 * a13 - a03 * a12;
	const det06 = a20 * a31 - a21 * a30;
	const det07 = a20 * a32 - a22 * a30;
	const det08 = a20 * a33 - a23 * a30;
	const det09 = a21 * a32 - a22 * a31;
	const det10 = a21 * a33 - a23 * a31;
	const det11 = a22 * a33 - a23 * a32;

	let det = (det00 * det11 - det01 * det10 + det02 * det09 + det03 * det08 - det04 * det07 + det05 * det06);

	if (!det) {
		return null;
	}

	det = 1.0 / det;

	return [
		(a11 * det11 - a12 * det10 + a13 * det09) * det,
		(-a01 * det11 + a02 * det10 - a03 * det09) * det,
		(a31 * det05 - a32 * det04 + a33 * det03) * det,
		(-a21 * det05 + a22 * det04 - a23 * det03) * det,
		(-a10 * det11 + a12 * det08 - a13 * det07) * det,
		(a00 * det11 - a02 * det08 + a03 * det07) * det,
		(-a30 * det05 + a32 * det02 - a33 * det01) * det,
		(a20 * det05 - a22 * det02 + a23 * det01) * det,
		(a10 * det10 - a11 * det08 + a13 * det06) * det,
		(-a00 * det10 + a01 * det08 - a03 * det06) * det,
		(a30 * det04 - a31 * det02 + a33 * det00) * det,
		(-a20 * det04 + a21 * det02 - a23 * det00) * det,
		(-a10 * det09 + a11 * det07 - a12 * det06) * det,
		(a00 * det09 - a01 * det07 + a02 * det06) * det,
		(-a30 * det03 + a31 * det01 - a32 * det00) * det,
		(a20 * det03 - a21 * det01 + a22 * det00) * det,
	];
}

export function matrix_transpose(mat : Matrix) : Matrix {
	return [
		mat[0], mat[4], mat[8], mat[12],
		mat[1], mat[5], mat[9], mat[13],
		mat[2], mat[6], mat[10], mat[14],
		mat[3], mat[7], mat[11], mat[15]
	];
}

export function distance_sq(vec1 : Vec3, vec2 : Vec3) : number {
	let dx = vec2[0]-vec1[0];
	let dy = vec2[1]-vec1[1];
	let dz = vec2[2]-vec1[2];
	return dx*dx + dy*dy + dz*dz;
}

export function distance_xz_sq(vec1 : Vec3, vec2 : Vec3) : number {
	return distance_sq([vec1[0], 0, vec1[2]], [vec2[0], 0, vec2[2]]);
}

export function lerp(a : number, b : number, fac : number) : number {
	return (a * (1 - fac)) + (b * fac); 
}

export const identity_matrix : Matrix = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
