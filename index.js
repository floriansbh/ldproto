import {EventEmitter} from "events";
import {randomBytes} from "crypto";

const MAX_FRAME_SIZE = 65535;

// CLIENT HELLO
// [u8 Frame Type]

// SERVER HELLO
// [u8 Frame Type, u32 Session ID]

// PONG
// [u8 Frame Type]

// PING
// [u8 Frame Type]

// END
// [u8 Frame Type]

// DATA
// [u8 Frame Type, u16 Frame Length, ...Body]

// Frame Types
// - CLIENT HELLO (5)
// - SERVER HELLO (4)
// - PONG (3)
// - PING (2)
// - END (1)
// - DATA (0)

export class LdpStream extends EventEmitter {
    #stream;
    #missingFrameLength;
    #frames;
    #chunks;
    sessionId;
    rtt;

    constructor(stream) {
        super();
        this.#stream = stream;
        this.#missingFrameLength = 0;
        this.#frames = [];
        this.#chunks = [];
    }

    listen() {
        this.#stream.on("data", (data) => {
            if (this.#missingFrameLength > 0) {
                if (data.length >= this.#missingFrameLength) {
                    const frame = Buffer.concat([...this.#chunks, data.subarray(0, this.#missingFrameLength)]);
                    const offset = this.#missingFrameLength;
                    this.#chunks.length = 0;
                    this.#missingFrameLength = 0;
                    this.#frames.push(frame);
                    this.#processRemainingData(data.subarray(offset));
                } else {
                    this.#chunks.push(data);
                    this.#missingFrameLength -= data.length;
                }
            } else {
                if (this.#chunks.length > 0) {
                    data = Buffer.concat([...this.#chunks, data]);
                    this.#chunks.length = 0;
                }
                this.#processData(data);
            }
        });
    }

    #processRemainingData(data) {
        if (data.length > 0) {
            this.#processData(data);
        }
    }

    #processData(data) {
        const frameType = data.readUInt8();
        if (frameType === 0 && data.length >= 3) { // DATA
            const frameLength = data.readUInt16BE(1);
            if (frameLength > (data.length - 3)) {
                this.#chunks.push(data.subarray(3));
                this.#missingFrameLength = frameLength - (data.length - 3);
            } else {
                this.#frames.push(data.subarray(3, frameLength + 3));
                this.#processRemainingData(data.subarray(frameLength + 3));
            }
        } else if (frameType === 1) { // END
            this.emit("message", Buffer.concat(this.#frames));
            this.#frames.length = 0;
            this.#processRemainingData(data.subarray(1));
        } else if (frameType === 2) { // PING
            this.#stream.write(new Uint8Array([3])); // PONG
            this.emit("ping");
            this.#processRemainingData(data.subarray(1));
        } else if (frameType === 3) { // PONG
            this.emit("pong");
            this.#processRemainingData(data.subarray(1));
        } else if (frameType === 4 && data.length >= 5) { // SERVER HELLO
            this.sessionId = data.subarray(1, 5);
            this.#stream.write(new Uint8Array([5])); // CLIENT HELLO
            this.emit("serverHello");
            this.#processRemainingData(data.subarray(5));
        } else if (frameType === 5) { // CLIENT HELLO
            this.emit("clientHello");
            this.#processRemainingData(data.subarray(1));
        } else {
            this.#chunks.push(data);
        }
    }

    #write(msg) {
        if (!Buffer.isBuffer(msg)) msg = Buffer.from(msg);
        this.#stream.cork();
        for (let i = 0; i < msg.length;) {
            const frameLength = Math.min(msg.length - i, MAX_FRAME_SIZE);
            const buf = Buffer.alloc(3);
            buf.writeUInt16BE(frameLength, 1);
            this.#stream.write(buf); // DATA
            this.#stream.write(msg.subarray(i, i + frameLength));
            i += frameLength;
        }
        this.#stream.uncork();
    }

    /*#randomId() {
        let hexDate = Date.now().toString(16);
        if (hexDate.length % 2) hexDate = "0" + hexDate;
        const tsBuffer = Buffer.from(hexDate, "hex");
        return Buffer.concat([tsBuffer, this.sessionId, randomBytes(2)]);
    }*/

    send(msg) {
        this.#write(msg);
        this.#stream.write(new Uint8Array([1])); // END
    }

    ping() {
        const pingTs = Date.now();
        this.#stream.write(new Uint8Array([2])); // PING
        return new Promise(resolve => this.once("pong", () => {
            this.rtt = Date.now() - pingTs;
            resolve();
        }));
    }

    greet() {
        const greetTs = Date.now();
        this.sessionId = randomBytes(4);
        this.#stream.write(Buffer.concat([new Uint8Array([4]), this.sessionId])); // SERVER HELLO
        return new Promise(resolve => this.once("clientHello", () => {
            this.rtt = Date.now() - greetTs;
            resolve();
        }));
    }
}
