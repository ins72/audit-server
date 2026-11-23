'use strict';

// A small QR code encoder: byte mode, error correction level L, versions 1 to 6 (up to 134 bytes), mask 0. That is
// enough for the sign-in addresses we put in QR codes, and avoids a dependency. Output is an SVG string.

// version -> [total codewords, error-correction codewords per block, blocks, alignment pattern centres]
const VERSIONS = {
    1: [26, 7, 1, []], 2: [44, 10, 1, [6, 18]], 3: [70, 15, 1, [6, 22]], 4: [100, 20, 1, [6, 26]], 5: [134, 26, 1, [6, 30]], 6: [172, 18, 2, [6, 34]]
};

const EXP = new Array(512);
const LOG = new Array(256);
(() => {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

const reedSolomon = (data, ecLength) => {
    let generator = [1];
    for (let i = 0; i < ecLength; i += 1) {
        const next = new Array(generator.length + 1).fill(0);
        generator.forEach((coefficient, j) => {
            next[j] ^= coefficient;
            next[j + 1] ^= mul(coefficient, EXP[i]);
        });
        generator = next;
    }
    const remainder = new Array(ecLength).fill(0);
    for (const byte of data) {
        const factor = byte ^ remainder.shift();
        remainder.push(0);
        generator.slice(1).forEach((coefficient, i) => { remainder[i] ^= mul(coefficient, factor); });
    }
    return remainder;
};

const bch = (value, poly, degree) => {
    let result = value << degree;
    for (let i = 14; i >= degree; i -= 1) if (result & (1 << i)) result ^= poly << (i - degree);
    return (value << degree) | result;
};

const encode = (text) => {
    const bytes = Buffer.from(String(text), 'utf8');
    const version = Object.keys(VERSIONS).map(Number).find((v) => {
        const [total, ec, blocks] = VERSIONS[v];
        return bytes.length + 2 <= total - ec * blocks;
    });
    if (!version) throw new Error('QR text too long');
    const [total, ecPerBlock, blockCount, centres] = VERSIONS[version];
    const dataCodewords = total - ecPerBlock * blockCount;

    const bits = [];
    const push = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, 8);
    bytes.forEach((byte) => push(byte, 8));
    push(0, Math.min(4, dataCodewords * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0; data.length < dataCodewords; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);

    const perBlock = dataCodewords / blockCount;
    const blocks = Array.from({ length: blockCount }, (_, i) => data.slice(i * perBlock, (i + 1) * perBlock));
    const ecBlocks = blocks.map((block) => reedSolomon(block, ecPerBlock));
    const stream = [];
    for (let i = 0; i < perBlock; i += 1) blocks.forEach((block) => stream.push(block[i]));
    for (let i = 0; i < ecPerBlock; i += 1) ecBlocks.forEach((block) => stream.push(block[i]));

    const size = 17 + 4 * version;
    const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
    const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) matrix[y][x] = dark; };
    const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy += 1) {
            for (let dx = -4; dx <= 4; dx += 1) {
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                set(cx + dx, cy + dy, d !== 4 && d !== 2);
            }
        }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    for (let i = 8; i < size - 8; i += 1) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
    for (const cx of centres) {
        for (const cy of centres) {
            if ((cx === 6 && cy === 6) || (cx === 6 && cy === centres[centres.length - 1]) || (cy === 6 && cx === centres[centres.length - 1])) continue;
            for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }
    set(8, size - 8, true);
    const reserved = matrix.map((row) => row.map((cell) => cell !== null));
    for (let i = 0; i < 9; i += 1) { reserved[8][i] = true; reserved[i][8] = true; }
    for (let i = 0; i < 8; i += 1) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }

    // data bits in the zig-zag order, mask 0: flip where (row + column) is even
    const stream2 = stream.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
    let index = 0;
    for (let x = size - 1; x > 0; x -= 2) {
        if (x === 6) x -= 1;
        for (let step = 0; step < size; step += 1) {
            const upward = ((x + 1) & 2) === 0; // every other column pair runs bottom to top
            const y = upward ? size - 1 - step : step;
            for (const column of [x, x - 1]) {
                if (reserved[y][column]) continue;
                const bit = index < stream2.length ? stream2[index] : 0;
                index += 1;
                matrix[y][column] = (bit === 1) !== ((y + column) % 2 === 0);
            }
        }
    }
    // format information: level L (01) + mask 0 (000)
    const format = bch(0b01000, 0x537, 10) ^ 0x5412;
    const bit = (i) => ((format >> i) & 1) === 1;
    for (let i = 0; i <= 5; i += 1) matrix[i][8] = bit(i);
    matrix[7][8] = bit(6);
    matrix[8][8] = bit(7);
    matrix[8][7] = bit(8);
    for (let i = 9; i < 15; i += 1) matrix[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i += 1) matrix[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i += 1) matrix[size - 15 + i][8] = bit(i);
    return { size, matrix: matrix.map((row) => row.map(Boolean)) };
};

const toSvg = (text, { margin = 4, dark = '#000', light = '#fff' } = {}) => {
    const { size, matrix } = encode(text);
    const total = size + margin * 2;
    const cells = [];
    matrix.forEach((row, y) => row.forEach((on, x) => { if (on) cells.push(`M${x + margin} ${y + margin}h1v1h-1z`); }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="${light}"/><path d="${cells.join('')}" fill="${dark}"/></svg>`;
};

module.exports = { encode, toSvg };
