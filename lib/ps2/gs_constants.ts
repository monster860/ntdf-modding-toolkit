export enum GsStorageFormat {
	PSMCT32 = 0b000000,
	PSMCT24 = 0b000001,
	PSMCT16 = 0b000010,
	PSMCT16S = 0b001010,
	PSMT8 = 0b010011,
	PSMT4 = 0b010100,
	PSMT8H = 0b011011,
	PSMT4HL = 0b100100,
	PSMT4HH = 0b101100,
	PSMZ32 = 0b110000,
	PSMZ24 = 0b110001,
	PSMZ16 = 0b110010,
	PSMZ16S = 0b111010
};

export enum GsTextureFunction {
	MODULATE = 0,
	DECAL = 1,
	HIGHLIGHT = 2,
	HIGHLIGHT2 = 3
};

export enum GsAlphaTestMethod {
	NEVER = 0,
	ALWAYS = 1,
	LESS = 2,
	LEQUAL = 3,
	EQUAL = 4,
	GEQUAL = 5,
	GREATER = 6,
	NOTEQUAL = 7
};

export enum GsAlphaFailMethod {
	KEEP = 0,
	FB_ONLY = 1,
	ZB_ONLY = 2,
	RGB_ONLY = 3
};

export enum GsDepthTestMethod {
	NEVER = 0,
	ALWAYS = 1,
	GEQUAL = 2,
	GREATER = 3
};

export enum GsFilter {
	NEAREST = 0,
	LINEAR = 1,
	NEAREST_MIPMAP_NEAREST = 2,
	NEAREST_MIPMAP_LINEAR = 3,
	LINEAR_MIPMAP_NEAREST = 4,
	LINEAR_MIPMAP_LINEAR = 5
};

export enum GsWrapMode {
	REPEAT = 0,
	CLAMP = 1,
	REGION_CLAMP = 2,
	REGION_REPEAT = 3
};

export enum GsColorParam {
	RgbSource = 0,
	RgbDest = 1,
	Zero = 2
};

export enum GsAlphaParam {
	AlphaSource = 0,
	AlphaDest = 1,
	Fix = 2
};

export enum GsRegister {
	PRIM = 0x00,
	RGBAQ = 0x01,
	ST = 0x02,
	UV = 0x03,
	XYZF2 = 0x04,
	XYZ2 = 0x05,
	TEX0_1 = 0x06,
	TEX0_2 = 0x07,
	CLAMP_1 = 0x08,
	CLAMP_2 = 0x09,
	FOG = 0x0a,
	XYZF3 = 0x0c,
	XYZ3 = 0x0d,
	TEX1_1 = 0x14,
	TEX1_2 = 0x15,
	TEX2_1 = 0x16,
	TEX2_2 = 0x17,
	XYOFFSET_1 = 0x18,
	XYOFFSET_2 = 0x19,
	PRMODECONT = 0x1a,
	PRMODE = 0x1b,
	TEXCLUT = 0x1c,
	SCANMSK = 0x22,
	MIPTBP1_1 = 0x34,
	MIPTBP1_2 = 0x35,
	MIPTBP2_1 = 0x36,
	MIPTBP2_2 = 0x37,
	TEXA = 0x3b,
	FOGCOL = 0x3d,
	TEXFLUSH = 0x3f,
	SCISSOR_1 = 0x40,
	SCISSOR_2 = 0x41,
	ALPHA_1 = 0x42,
	ALPHA_2 = 0x43,
	DIMX = 0x44,
	DTHE = 0x45,
	COLCLAMP = 0x46,
	TEST_1 = 0x47,
	TEST_2 = 0x48,
	PABE = 0x49,
	FBA_1 = 0x4a,
	FBA_2 = 0x4b,
	FRAME_1 = 0x4c,
	FRAME_2 = 0x4d,
	ZBUF_1 = 0x4e,
	ZBUF_2 = 0x4f,
	BITBLTBUF = 0x50,
	TRXPOS = 0x51,
	TRXREG = 0x52,
	TRXDIR = 0x53,
	HWREG = 0x54,
	SIGNAL = 0x60,
	FINISH = 0x61,
	LABEL = 0x62
}
