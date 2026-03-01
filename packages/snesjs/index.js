// SnesJs vendored as an ES module.
// Source: https://github.com/angelo-wf/SnesJs (MIT)
// Helper globals expected by the original script-tag-based source files.

function clearArray(arr) {
  for (let i = 0; i < arr.length; i++) arr[i] = 0;
}
function getByteRep(val) {
  return ('0' + val.toString(16)).slice(-2).toUpperCase();
}
function getWordRep(val) {
  return ('000' + val.toString(16)).slice(-4).toUpperCase();
}
function getLongRep(val) {
  return ('00000' + val.toString(16)).slice(-6).toUpperCase();
}
function log() {} // no-op in headless use


function Cart(data, header, isHirom) {
  this.header = header;
  this.data = data;

  this.isHirom = isHirom;

  this.sram = new Uint8Array(header.ramSize);
  this.hasSram = header.chips > 0;

  this.banks = header.romSize / 0x8000;
  this.sramSize = header.ramSize;
  log(
    "Loaded " + (this.isHirom ? "HiROM" : "LoROM") + " rom: \"" + header.name + "\"; " +
    "Banks: " + this.banks +
    "; Sram size: $" + getWordRep(this.hasSram ? this.sramSize : 0)
  );

  this.reset = function(hard) {
    if(hard) {
      clearArray(this.sram);
    }
  }
  this.reset();

  this.read = function(bank, adr) {
    if(!this.isHirom) {
      if(adr < 0x8000) {
        if(bank >= 0x70 && bank < 0x7e && this.hasSram) {
          // sram
          return this.sram[
            (((bank - 0x70) << 15) | (adr & 0x7fff)) & (this.sramSize - 1)
          ];
        }
      }
      return this.data[((bank & (this.banks - 1)) << 15) | (adr & 0x7fff)];
    } else {
      if(adr >= 0x6000 && adr < 0x8000 && this.hasSram) {
        if((bank < 0x40 || (bank >= 0x80 && bank < 0xc0))) {
          // sram
          return this.sram[
            (((bank & 0x3f) << 13) | (adr & 0x1fff)) & (this.sramSize - 1)
          ]
        }
      }
      return this.data[(((bank & 0x3f) & (this.banks - 1)) << 16) | adr];
    }
  }

  this.write = function(bank, adr, value) {
    if(!this.isHirom) {
      if(adr < 0x8000 && bank >= 0x70 && bank < 0x7e && this.hasSram) {
        this.sram[
          (((bank - 0x70) << 15) | (adr & 0x7fff)) & (this.sramSize - 1)
        ] = value;
      }
    } else {
      if(adr >= 0x6000 && adr < 0x8000 && this.hasSram) {
        if((bank < 0x40 || (bank >= 0x80 && bank < 0xc0))) {
          // sram
          this.sram[
            (((bank & 0x3f) << 13) | (adr & 0x1fff)) & (this.sramSize - 1)
          ] = value;
        }
      }
    }
  }
}

function Dsp(apu) {

  this.apu = apu;

  this.ram = new Uint8Array(0x80);

  this.samplesL = new Float64Array(534);
  this.samplesR = new Float64Array(534);
  this.sampleOffset = 0;

  this.rates = [
    0, 2048, 1536, 1280, 1024, 768, 640, 512,
    384, 320, 256, 192, 160, 128, 96, 80,
    64, 48, 40, 32, 24, 20, 16, 12,
    10, 8, 6, 5, 4, 3, 2, 1
  ];

  // from NoCach's fullsnes.txt
  this.gaussVals = [
    0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, // \
    0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x002, 0x002, 0x002, 0x002, 0x002, //
    0x002, 0x002, 0x003, 0x003, 0x003, 0x003, 0x003, 0x004, 0x004, 0x004, 0x004, 0x004, 0x005, 0x005, 0x005, 0x005, //
    0x006, 0x006, 0x006, 0x006, 0x007, 0x007, 0x007, 0x008, 0x008, 0x008, 0x009, 0x009, 0x009, 0x00A, 0x00A, 0x00A, //
    0x00B, 0x00B, 0x00B, 0x00C, 0x00C, 0x00D, 0x00D, 0x00E, 0x00E, 0x00F, 0x00F, 0x00F, 0x010, 0x010, 0x011, 0x011, //
    0x012, 0x013, 0x013, 0x014, 0x014, 0x015, 0x015, 0x016, 0x017, 0x017, 0x018, 0x018, 0x019, 0x01A, 0x01B, 0x01B, // entry
    0x01C, 0x01D, 0x01D, 0x01E, 0x01F, 0x020, 0x020, 0x021, 0x022, 0x023, 0x024, 0x024, 0x025, 0x026, 0x027, 0x028, // 000h..0FFh
    0x029, 0x02A, 0x02B, 0x02C, 0x02D, 0x02E, 0x02F, 0x030, 0x031, 0x032, 0x033, 0x034, 0x035, 0x036, 0x037, 0x038, //
    0x03A, 0x03B, 0x03C, 0x03D, 0x03E, 0x040, 0x041, 0x042, 0x043, 0x045, 0x046, 0x047, 0x049, 0x04A, 0x04C, 0x04D, //
    0x04E, 0x050, 0x051, 0x053, 0x054, 0x056, 0x057, 0x059, 0x05A, 0x05C, 0x05E, 0x05F, 0x061, 0x063, 0x064, 0x066, //
    0x068, 0x06A, 0x06B, 0x06D, 0x06F, 0x071, 0x073, 0x075, 0x076, 0x078, 0x07A, 0x07C, 0x07E, 0x080, 0x082, 0x084, //
    0x086, 0x089, 0x08B, 0x08D, 0x08F, 0x091, 0x093, 0x096, 0x098, 0x09A, 0x09C, 0x09F, 0x0A1, 0x0A3, 0x0A6, 0x0A8, //
    0x0AB, 0x0AD, 0x0AF, 0x0B2, 0x0B4, 0x0B7, 0x0BA, 0x0BC, 0x0BF, 0x0C1, 0x0C4, 0x0C7, 0x0C9, 0x0CC, 0x0CF, 0x0D2, //
    0x0D4, 0x0D7, 0x0DA, 0x0DD, 0x0E0, 0x0E3, 0x0E6, 0x0E9, 0x0EC, 0x0EF, 0x0F2, 0x0F5, 0x0F8, 0x0FB, 0x0FE, 0x101, //
    0x104, 0x107, 0x10B, 0x10E, 0x111, 0x114, 0x118, 0x11B, 0x11E, 0x122, 0x125, 0x129, 0x12C, 0x130, 0x133, 0x137, //
    0x13A, 0x13E, 0x141, 0x145, 0x148, 0x14C, 0x150, 0x153, 0x157, 0x15B, 0x15F, 0x162, 0x166, 0x16A, 0x16E, 0x172, // /
    0x176, 0x17A, 0x17D, 0x181, 0x185, 0x189, 0x18D, 0x191, 0x195, 0x19A, 0x19E, 0x1A2, 0x1A6, 0x1AA, 0x1AE, 0x1B2, // \
    0x1B7, 0x1BB, 0x1BF, 0x1C3, 0x1C8, 0x1CC, 0x1D0, 0x1D5, 0x1D9, 0x1DD, 0x1E2, 0x1E6, 0x1EB, 0x1EF, 0x1F3, 0x1F8, //
    0x1FC, 0x201, 0x205, 0x20A, 0x20F, 0x213, 0x218, 0x21C, 0x221, 0x226, 0x22A, 0x22F, 0x233, 0x238, 0x23D, 0x241, //
    0x246, 0x24B, 0x250, 0x254, 0x259, 0x25E, 0x263, 0x267, 0x26C, 0x271, 0x276, 0x27B, 0x280, 0x284, 0x289, 0x28E, //
    0x293, 0x298, 0x29D, 0x2A2, 0x2A6, 0x2AB, 0x2B0, 0x2B5, 0x2BA, 0x2BF, 0x2C4, 0x2C9, 0x2CE, 0x2D3, 0x2D8, 0x2DC, //
    0x2E1, 0x2E6, 0x2EB, 0x2F0, 0x2F5, 0x2FA, 0x2FF, 0x304, 0x309, 0x30E, 0x313, 0x318, 0x31D, 0x322, 0x326, 0x32B, // entry
    0x330, 0x335, 0x33A, 0x33F, 0x344, 0x349, 0x34E, 0x353, 0x357, 0x35C, 0x361, 0x366, 0x36B, 0x370, 0x374, 0x379, // 100h..1FFh
    0x37E, 0x383, 0x388, 0x38C, 0x391, 0x396, 0x39B, 0x39F, 0x3A4, 0x3A9, 0x3AD, 0x3B2, 0x3B7, 0x3BB, 0x3C0, 0x3C5, //
    0x3C9, 0x3CE, 0x3D2, 0x3D7, 0x3DC, 0x3E0, 0x3E5, 0x3E9, 0x3ED, 0x3F2, 0x3F6, 0x3FB, 0x3FF, 0x403, 0x408, 0x40C, //
    0x410, 0x415, 0x419, 0x41D, 0x421, 0x425, 0x42A, 0x42E, 0x432, 0x436, 0x43A, 0x43E, 0x442, 0x446, 0x44A, 0x44E, //
    0x452, 0x455, 0x459, 0x45D, 0x461, 0x465, 0x468, 0x46C, 0x470, 0x473, 0x477, 0x47A, 0x47E, 0x481, 0x485, 0x488, //
    0x48C, 0x48F, 0x492, 0x496, 0x499, 0x49C, 0x49F, 0x4A2, 0x4A6, 0x4A9, 0x4AC, 0x4AF, 0x4B2, 0x4B5, 0x4B7, 0x4BA, //
    0x4BD, 0x4C0, 0x4C3, 0x4C5, 0x4C8, 0x4CB, 0x4CD, 0x4D0, 0x4D2, 0x4D5, 0x4D7, 0x4D9, 0x4DC, 0x4DE, 0x4E0, 0x4E3, //
    0x4E5, 0x4E7, 0x4E9, 0x4EB, 0x4ED, 0x4EF, 0x4F1, 0x4F3, 0x4F5, 0x4F6, 0x4F8, 0x4FA, 0x4FB, 0x4FD, 0x4FF, 0x500, //
    0x502, 0x503, 0x504, 0x506, 0x507, 0x508, 0x50A, 0x50B, 0x50C, 0x50D, 0x50E, 0x50F, 0x510, 0x511, 0x511, 0x512, //
    0x513, 0x514, 0x514, 0x515, 0x516, 0x516, 0x517, 0x517, 0x517, 0x518, 0x518, 0x518, 0x518, 0x518, 0x519, 0x519, // /
  ];

  // decode buffer for BRR decoding
  this.decodeBuffer = new Int16Array(19*8);
  // attack rate, decay rate, sustain rate, release rate, gain rate
  this.rateNums = new Int16Array(5*8);

  this.reset = function() {
    clearArray(this.ram);

    clearArray(this.decodeBuffer);
    clearArray(this.rateNums);
    // set rate for release to 1
    for(let i = 0; i < 8; i++) {
      this.rateNums[i * 5 + 3] = 1;
    }

    this.pitch = [0, 0, 0, 0, 0, 0, 0, 0];
    this.counter = [0, 0, 0, 0, 0, 0, 0, 0];
    this.pitchMod = [false, false, false, false, false, false, false, false];

    this.srcn = [0, 0, 0, 0, 0, 0, 0, 0];
    this.decodeOffset = [0, 0, 0, 0, 0, 0, 0, 0];
    this.prevFlags = [0, 0, 0, 0, 0, 0, 0, 0];
    this.old = [0, 0, 0, 0, 0, 0, 0, 0];
    this.older = [0, 0, 0, 0, 0, 0, 0, 0];

    this.enableNoise = [false, false, false, false, false, false, false, false];
    this.noiseSample = -0x4000;
    this.noiseRate = 0;
    this.noiseCounter = 0;

    this.rateCounter = [0, 0, 0, 0, 0, 0, 0, 0];
    // 0: attack, 1: decay, 2: sustain, 3: release, 4: gain
    this.adsrState = [3, 3, 3, 3, 3, 3, 3, 3];
    this.sustainLevel = [0, 0, 0, 0, 0, 0, 0, 0];
    this.useGain = [false, false, false, false, false, false, false, false];
    this.gainMode = [0, 0, 0, 0, 0, 0, 0, 0];
    this.directGain = [false, false, false, false, false, false, false, false];
    this.gainValue = [0, 0, 0, 0, 0, 0, 0, 0];

    this.gain = [0, 0, 0, 0, 0, 0, 0, 0];

    this.channelVolumeL = [0, 0, 0, 0, 0, 0, 0, 0];
    this.channelVolumeR = [0, 0, 0, 0, 0, 0, 0, 0];
    this.volumeL = 0;
    this.volumeR = 0;
    this.mute = true;

    this.resetFlag = true;
    this.noteOff = [true, true, true, true, true, true, true, true];

    this.sampleOut = [0, 0, 0, 0, 0, 0, 0, 0];

    this.dirPage = 0;
  }
  this.reset();

  // TODO: echo

  this.cycle = function() {

    let totalL = 0;
    let totalR = 0;
    for(let i = 0; i < 8; i++) {
      this.cycleChannel(i);
      totalL += (this.sampleOut[i] * this.channelVolumeL[i]) >> 6;
      totalR += (this.sampleOut[i] * this.channelVolumeR[i]) >> 6;
      totalL = totalL < -0x8000 ? -0x8000 : (totalL > 0x7fff ? 0x7fff : totalL);
      totalR = totalR < -0x8000 ? -0x8000 : (totalR > 0x7fff ? 0x7fff : totalR);
    }
    totalL = (totalL * this.volumeL) >> 7;
    totalR = (totalR * this.volumeR) >> 7;
    totalL = totalL < -0x8000 ? -0x8000 : (totalL > 0x7fff ? 0x7fff : totalL);
    totalR = totalR < -0x8000 ? -0x8000 : (totalR > 0x7fff ? 0x7fff : totalR);
    if(this.mute) {
      totalL = 0;
      totalR = 0;
    }

    this.handleNoise();

    this.samplesL[this.sampleOffset] = totalL / 0x8000;
    this.samplesR[this.sampleOffset] = totalR / 0x8000;
    this.sampleOffset++;
    if(this.sampleOffset > 533) {
      // going past the buffer
      this.sampleOffset = 533;
    }
  }

  this.decodeBrr = function(ch) {
    // copy last 3 old samples to 3 samples from previous brr for interpolation
    this.decodeBuffer[ch * 19] = this.decodeBuffer[ch * 19 + 16];
    this.decodeBuffer[ch * 19 + 1] = this.decodeBuffer[ch * 19 + 17];
    this.decodeBuffer[ch * 19 + 2] = this.decodeBuffer[ch * 19 + 18];

    if(this.prevFlags[ch] === 1 || this.prevFlags[ch] === 3) {
      let sampleAdr = (this.dirPage << 8) + (this.srcn[ch] * 4);
      let loopAdr = this.apu.ram[(sampleAdr + 2) & 0xffff];
      loopAdr |= this.apu.ram[(sampleAdr + 3) & 0xffff] << 8
      this.decodeOffset[ch] = loopAdr;
      if(this.prevFlags[ch] === 1) {
        this.gain[ch] = 0;
        this.adsrState[ch] = 3;
      }
      this.ram[0x7c] |= (1 << ch); // set ENDx
    }
    let header = this.apu.ram[this.decodeOffset[ch]++];
    this.decodeOffset[ch] &= 0xffff;
    let shift = header >> 4;
    let filter = (header & 0xc) >> 2;
    this.prevFlags[ch] = header & 0x3;
    let byte = 0;
    for(let i = 0; i < 16; i++) {
      let s = byte & 0xf;
      if((i & 1) === 0) {
        byte = this.apu.ram[this.decodeOffset[ch]++];
        this.decodeOffset[ch] &= 0xffff;
        s = byte >> 4;
      }
      s = s > 7 ? s - 16 : s;
      if(shift <= 0xc) {
        s = (s << shift) >> 1;
      } else {
        s = s < 0 ? -2048 : 2048;
      }
      let old = this.old[ch];
      let older = this.older[ch];
      switch(filter) {
        case 1: {
          s = s + old * 1 + ((-old * 1) >> 4);
          break;
        }
        case 2: {
          s = s + old * 2 + ((-old * 3) >> 5) - older + ((older * 1) >> 4);
          break;
        }
        case 3: {
          s = s + old * 2 + ((-old * 13) >> 6) - older + ((older * 3) >> 4);
          break;
        }
      }
      s = s > 0x7fff ? 0x7fff : s;
      s = s < -0x8000 ? -0x8000 : s;
      s &= 0x7fff;
      s = s > 0x3fff ? s - 0x8000 : s;
      this.older[ch] = this.old[ch];
      this.old[ch] = s;
      this.decodeBuffer[ch * 19 + i + 3] = s;
    }
  }

  this.interpolate = function(ch, sampleNum, offset) {
    let news = this.decodeBuffer[ch * 19 + sampleNum + 3];
    let old =  this.decodeBuffer[ch * 19 + sampleNum + 2];
    let older =  this.decodeBuffer[ch * 19 + sampleNum + 1];
    let oldest =  this.decodeBuffer[ch * 19 + sampleNum ];
    let out = (this.gaussVals[0xff - offset] * oldest) >> 10;
    out += (this.gaussVals[0x1ff - offset] * older) >> 10;
    out += (this.gaussVals[0x100 + offset] * old) >> 10;
    out &= 0xffff;
    out = out > 0x7fff ? out - 0x10000 : out;
    out += (this.gaussVals[offset] * news) >> 10;
    out = out > 0x7fff ? 0x7fff : (out < -0x8000 ? -0x8000 : out);
    return out >> 1;
  }

  this.handleNoise = function() {
    if(this.noiseRate !== 0) {
      this.noiseCounter++;
    }
    if(this.noiseRate !== 0 && this.noiseCounter >= this.noiseRate) {
      this.noiseCounter = 0;
      let bit0 = this.noiseSample & 1;
      let bit1 = (this.noiseSample >> 1) & 1;
      this.noiseSample = ((this.noiseSample >> 1) & 0x3fff) | ((bit0 ^ bit1) << 14);
      this.noiseSample = this.noiseSample > 0x3fff ? this.noiseSample - 0x8000 : this.noiseSample;
    }
  }

  this.cycleChannel = function(ch) {
    // get the next sample
    let pitch = this.pitch[ch];
    if(this.pitchMod[ch]) {
      let factor = (this.sampleOut[ch - 1] >> 4) + 0x400;
      pitch = (pitch * factor) >> 10;
      pitch = pitch > 0x3fff ? 0x3fff : pitch;
    }
    this.counter[ch] += pitch;
    if(this.counter[ch] > 0xffff) {
      // decode next brr sample
      this.decodeBrr(ch);
    }
    this.counter[ch] &= 0xffff;
    // get the sample out the decode buffer, or get noise
    let sample;
    if(this.enableNoise[ch]) {
      sample = this.noiseSample;
    } else {
      // sample = this.decodeBuffer[ch * 19 + sampleNum + 3];
      sample = this.interpolate(ch, this.counter[ch] >> 12, (this.counter[ch] >> 4) & 0xff);
    }

    // now update the adsr/gain, if we reach the correct amount of cycles
    if(this.noteOff[ch] || this.resetFlag) {
      // if noteoff or reset flag is set, go to release
      this.adsrState[ch] = 3;
      if(this.resetFlag) {
        // also set gain to 0 if reset flag is set
        this.gain[ch] = 0;
      }
    }
    let rate = this.rateNums[ch * 5 + this.adsrState[ch]];
    if(rate !== 0) {
      // only increment if rate is not 0
      this.rateCounter[ch]++;
    }
    // if rate is 0, gain is never updated
    if(rate !== 0 && this.rateCounter[ch] >= rate) {
      this.rateCounter[ch] = 0;
      if(!this.directGain[ch] || !this.useGain[ch] || this.adsrState[ch] === 3) {
        // if not using direct gain, or not using gain at all (using ADSR),
        // or we are in release (which always works), clock it
        switch(this.adsrState[ch]) {
          case 0: {
            // attack
            this.gain[ch] += rate === 1 ? 1024 : 32;
            if(this.gain[ch] >= 0x7e0) {
              this.adsrState[ch] = 1;
            }
            if(this.gain[ch] > 0x7ff) {
              this.gain[ch] = 0x7ff;
            }
            break;
          }
          case 1: {
            // decay
            this.gain[ch] -= ((this.gain[ch] - 1) >> 8) + 1;
            if(this.gain[ch] < this.sustainLevel[ch]) {
              this.adsrState[ch] = 2;
            }
            break;
          }
          case 2: {
            // sustain
            this.gain[ch] -= ((this.gain[ch] - 1) >> 8) + 1;
            break;
          }
          case 3: {
            // release
            this.gain[ch] -= 8;
            if(this.gain[ch] < 0) {
              this.gain[ch] = 0;
            }
            break;
          }
          case 4: {
            // direct gain
            switch(this.gainMode[ch]) {
              case 0: {
                this.gain[ch] -= 32;
                if(this.gain[ch] < 0) {
                  this.gain[ch] = 0;
                }
                break;
              }
              case 1: {
                this.gain[ch] -= ((this.gain[ch] - 1) >> 8) + 1;
                break;
              }
              case 2: {
                this.gain[ch] += 32;
                if(this.gain[ch] > 0x7ff) {
                  this.gain[ch] = 0x7ff;
                }
                break;
              }
              case 3: {
                this.gain[ch] += this.gain[ch] < 0x600 ? 32 : 8;
                if(this.gain[ch] > 0x7ff) {
                  this.gain[ch] = 0x7ff;
                }
                break;
              }
            }
            break;
          }
        }
      }
    }
    if(this.directGain[ch] && this.useGain[ch] && this.adsrState[ch] !== 3) {
      // if using gain, specifcally direct gain and not in release, set the value directly
      this.gain[ch] = this.gainValue[ch];
    }
    let gainedVal = (sample * this.gain[ch]) >> 11;

    // write gain to ENVx and this value to OUTx
    this.ram[(ch << 4) | 8] = this.gain[ch] >> 4;
    this.ram[(ch << 4) | 9] = gainedVal >> 7;
    this.sampleOut[ch] = gainedVal;
  }

  this.read = function(adr) {
    return this.ram[adr & 0x7f];
  }

  this.write = function(adr, value) {
    let channel = (adr & 0x70) >> 4;
    switch(adr) {
      case 0x0: case 0x10: case 0x20: case 0x30: case 0x40: case 0x50: case 0x60: case 0x70: {
        this.channelVolumeL[channel] = (value > 0x7f ? value - 0x100 : value);
        break;
      }
      case 0x1: case 0x11: case 0x21: case 0x31: case 0x41: case 0x51: case 0x61: case 0x71: {
        this.channelVolumeR[channel] = (value > 0x7f ? value - 0x100 : value);
        break;
      }
      case 0x2: case 0x12: case 0x22: case 0x32: case 0x42: case 0x52: case 0x62: case 0x72: {
        this.pitch[channel] &= 0x3f00;
        this.pitch[channel] |= value;
        break;
      }
      case 0x3: case 0x13: case 0x23: case 0x33: case 0x43: case 0x53: case 0x63: case 0x73: {
        this.pitch[channel] &= 0xff;
        this.pitch[channel] |= (value << 8) & 0x3f00;
        break;
      }
      case 0x4: case 0x14: case 0x24: case 0x34: case 0x44: case 0x54: case 0x64: case 0x74: {
        this.srcn[channel] = value;
        break;
      }
      case 0x5: case 0x15: case 0x25: case 0x35: case 0x45: case 0x55: case 0x65: case 0x75: {
        this.rateNums[channel * 5 + 0] = this.rates[(value & 0xf) * 2 + 1];
        this.rateNums[channel * 5 + 1] = this.rates[((value & 0x70) >> 4) * 2 + 16];
        this.useGain[channel] = (value & 0x80) === 0;
        break;
      }
      case 0x6: case 0x16: case 0x26: case 0x36: case 0x46: case 0x56: case 0x66: case 0x76: {
        this.rateNums[channel * 5 + 2] = this.rates[value & 0x1f];
        this.sustainLevel[channel] = (((value & 0xe0) >> 5) + 1) * 0x100;
        break;
      }
      case 0x7: case 0x17: case 0x27: case 0x37: case 0x47: case 0x57: case 0x67: case 0x77: {
        if((value & 0x80) > 0) {
          this.directGain[channel] = false;
          this.gainMode[channel] = (value & 0x60) >> 5;
          this.rateNums[channel * 5 + 4] = this.rates[value & 0x1f];
        } else {
          this.directGain[channel] = true;
          this.gainValue[channel] = (value & 0x7f) * 16;
        }
        break;
      }
      case 0x0c: {
        this.volumeL = (value > 0x7f ? value - 0x100 : value);
        break;
      }
      case 0x1c: {
        this.volumeR = (value > 0x7f ? value - 0x100 : value);
        break;
      }
      case 0x2c: {
        break; // TODO (echo volume L)
      }
      case 0x3c: {
        break; // TODO (echo volume R)
      }
      case 0x4c: {
        let test = 1;
        for(let i = 0; i < 8; i++) {
          if((value & test) > 0) {
            this.prevFlags[i] = 0;
            let sampleAdr = (this.dirPage << 8) + (this.srcn[i] * 4);
            let startAdr = this.apu.ram[sampleAdr & 0xffff];
            startAdr |= this.apu.ram[(sampleAdr + 1) & 0xffff] << 8
            this.decodeOffset[i] = startAdr;
            this.gain[i] = 0;
            if(this.useGain[i]) {
              this.adsrState[i] = 4;
            } else {
              this.adsrState[i] = 0;
            }
            // clear the decode buffer for this channel
            for(let j = 0; j < 19; j++) {
              this.decodeBuffer[i * 19 + j] = 0;
            }
          }
          test <<= 1;
        }
        break;
      }
      case 0x5c: {
        let test = 1;
        for(let i = 0; i < 8; i++) {
          this.noteOff[i] = (value & test) > 0;
          test <<= 1;
        }
        break;
      }
      case 0x6c: {
        this.resetFlag = (value & 0x80) > 0;
        this.mute = (value & 0x40) > 0;
        // TODO: set echo writes
        this.noiseRate = this.rates[value & 0x1f];
        break;
      }
      case 0x7c: {
        // somewhat of a hack, to correctly get the 'writing any value clears all bits' behaviour
        this.ram[0x7c] = 0;
        value = 0;
        break;
      }
      case 0x0d: {
        break; // TODO (echo feedback volume)
      }
      case 0x2d: {
        let test = 2;
        for(let i = 1; i < 8; i++) {
          this.pitchMod[i] = (value & test) > 0;
          test <<= 1;
        }
        break;
      }
      case 0x3d: {
        let test = 1;
        for(let i = 0; i < 8; i++) {
          this.enableNoise[i] = (value & test) > 0;
          test <<= 1;
        }
        break;
      }
      case 0x4d: {
        break; // TODO (echo enable)
      }
      case 0x5d: {
        this.dirPage = value;
        break;
      }
      case 0x6d: {
        break; // TODO (echo address)
      }
      case 0x7d: {
        break; // TODO (echo delay)
      }
      case 0xf: case 0x1f: case 0x2f: case 0x3f: case 0x4f: case 0x5f: case 0x6f: case 0x7f: {
        break; // TODO (echo fir filter)
      }
    }
    this.ram[adr & 0x7f] = value;
  }

}

var Spc = (function() {

  // indexes in register arrays
  const A = 0;
  const X = 1;
  const Y = 2;
  const SP = 3;
  const PC = 0;

  const IMP = 0;
  const REL = 1;
  const DP = 2;
  const DPR = 3;
  const ABS = 4;
  const IND = 5;
  const IDX = 6;
  const IMM = 7;
  const DPX = 8;
  const ABX = 9;
  const ABY = 10;
  const IDY = 11;
  const DD = 12;
  const II = 13;
  const DI = 14;
  const DPY = 15;
  const ABB = 16;
  const DXR = 17;
  const IAX = 18;
  const IPI = 19;

  return function(mem) {

    this.mem = mem;

    this.r = new Uint8Array(4);
    this.br = new Uint16Array(1);

    this.modes = [
      IMP, IMP, DP , DPR, DP , ABS, IND, IDX, IMM, DD , ABB, DP , ABS, IMP, ABS, IMP,
      REL, IMP, DP , DPR, DPX, ABX, ABY, IDY, DI , II , DP , DPX, IMP, IMP, ABS, IAX,
      IMP, IMP, DP , DPR, DP , ABS, IND, IDX, IMM, DD , ABB, DP , ABS, IMP, DPR, REL,
      REL, IMP, DP , DPR, DPX, ABX, ABY, IDY, DI , II , DP , DPX, IMP, IMP, DP , ABS,
      IMP, IMP, DP , DPR, DP , ABS, IND, IDX, IMM, DD , ABB, DP , ABS, IMP, ABS, DP ,
      REL, IMP, DP , DPR, DPX, ABX, ABY, IDY, DI , II , DP , DPX, IMP, IMP, ABS, ABS,
      IMP, IMP, DP , DPR, DP , ABS, IND, IDX, IMM, DD , ABB, DP , ABS, IMP, DPR, IMP,
      REL, IMP, DP , DPR, DPX, ABX, ABY, IDY, DI , II , DP , DPX, IMP, IMP, DP , IMP,
      IMP, IMP, DP , DPR, DP , ABS, IND, IDX, IMM, DD , ABB, DP , ABS, IMM, IMP, DI ,
      REL, IMP, DP , DPR, DPX, ABX, ABY, IDY, DI , II , DP , DPX, IMP, IMP, IMP, IMP,
      IMP, IMP, DP , DPR, DP , ABS, IND, IDX, IMM, DD , ABB, DP , ABS, IMM, IMP, IPI,
      REL, IMP, DP , DPR, DPX, ABX, ABY, IDY, DI , II , DP , DPX, IMP, IMP, IMP, IPI,
      IMP, IMP, DP , DPR, DP , ABS, IND, IDX, IMM, ABS, ABB, DP , ABS, IMM, IMP, IMP,
      REL, IMP, DP , DPR, DPX, ABX, ABY, IDY, DP , DPY, DP , DPX, IMP, IMP, DXR, IMP,
      IMP, IMP, DP , DPR, DP , ABS, IND, IDX, IMM, ABS, ABB, DP , ABS, IMP, IMP, IMP,
      REL, IMP, DP , DPR, DPX, ABX, ABY, IDY, DP , DPY, DD , DPX, IMP, IMP, REL, IMP
    ];

    this.cycles = [
      2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8,
      2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
      2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4,
      2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
      2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6,
      2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
      2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5,
      2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
      2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5,
      2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12,5,
      2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4,
      2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4,
      2, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9,
      2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3,
      2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4, 3,
      2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3
    ];

    // function map is at bottom

    this.reset = function() {

      this.r[A] = 0;
      this.r[X] = 0;
      this.r[Y] = 0;
      this.r[SP] = 0;

      if(this.mem.read) {
        this.br[PC] = this.mem.read(0xfffe) | (this.mem.read(0xffff) << 8);
      } else {
        // if read not defined yet
        this.br[PC] = 0;
      }

      // flags
      this.n = false;
      this.v = false;
      this.p = false;
      this.b = false;
      this.h = false;
      this.i = false;
      this.z = false;
      this.c = false;

      this.cyclesLeft = 7; // a guess
    }
    this.reset();

    this.cycle = function() {
      if(this.cyclesLeft === 0) {
        // the spc in the snes does not have interrupts,
        // so no checking is needed
        let instr = this.mem.read(this.br[PC]++);
        let mode = this.modes[instr];
        this.cyclesLeft = this.cycles[instr];

        try {
          let eff = this.getAdr(mode);
          this.functions[instr].call(this, eff[0], eff[1], instr);
        } catch(e) {
          log("Error with opcode " + getByteRep(instr) + ": " + e);
        }
      }
      this.cyclesLeft--;
    }

    this.getP = function() {
      let value = 0;
      value |= this.n ? 0x80 : 0;
      value |= this.v ? 0x40 : 0;
      value |= this.p ? 0x20 : 0;
      value |= this.b ? 0x10 : 0;
      value |= this.h ? 0x08 : 0;
      value |= this.i ? 0x04 : 0;
      value |= this.z ? 0x02 : 0;
      value |= this.c ? 0x01 : 0;
      return value;
    }

    this.setP = function(value) {
      this.n = (value & 0x80) > 0;
      this.v = (value & 0x40) > 0;
      this.p = (value & 0x20) > 0;
      this.b = (value & 0x10) > 0;
      this.h = (value & 0x08) > 0;
      this.i = (value & 0x04) > 0;
      this.z = (value & 0x02) > 0;
      this.c = (value & 0x01) > 0;
    }

    this.setZandN = function(val) {
      val &= 0xff;
      this.n = val > 0x7f;
      this.z = val === 0;
    }

    this.getSigned = function(val) {
      if(val > 127) {
        return -(256 - val);
      }
      return val;
    }

    this.doBranch = function(check, rel) {
      if(check) {
        this.br[PC] += rel;
        // taken branch: 2 extra cycles
        this.cyclesLeft += 2;
      }
    }

    this.push = function(value) {
      this.mem.write(this.r[SP] | 0x100, value);
      this.r[SP]--;
    }

    this.pop = function() {
      this.r[SP]++;
      return this.mem.read(this.r[SP] | 0x100);
    }

    this.getAdr = function(mode) {
      switch(mode) {
        case IMP: {
          // implied
          return [0, 0];
        }
        case REL: {
          // relative
          let rel = this.mem.read(this.br[PC]++);
          return [this.getSigned(rel), 0];
        }
        case DP: {
          // direct page (with next byte for 16-bit ops)
          let adr = this.mem.read(this.br[PC]++);
          return [
            adr | (this.p ? 0x100 : 0),
            ((adr + 1) & 0xff) | (this.p ? 0x100 : 0)
          ];
        }
        case DPR: {
          // direct page, relative
          let adr = this.mem.read(this.br[PC]++);
          let rel = this.mem.read(this.br[PC]++);
          return [adr | (this.p ? 0x100 : 0), this.getSigned(rel)];
        }
        case ABS: {
          // absolute
          let adr = this.mem.read(this.br[PC]++);
          adr |= this.mem.read(this.br[PC]++) << 8;
          return [adr, 0];
        }
        case IND: {
          // indirect
          return [this.r[X] | (this.p ? 0x100 : 0), 0];
        }
        case IDX: {
          // indexed indirect direct
          let pointer = this.mem.read(this.br[PC]++);
          let adr = this.mem.read(
            ((pointer + this.r[X]) & 0xff) | (this.p ? 0x100 : 0)
          );
          adr |= this.mem.read(
            ((pointer + 1 + this.r[X]) & 0xff) | (this.p ? 0x100 : 0)
          ) << 8;
          return [adr, 0];
        }
        case IMM: {
          // immediate
          return [this.br[PC]++, 0];
        }
        case DPX: {
          // direct page indexed on x
          let adr = this.mem.read(this.br[PC]++);
          return [((adr + this.r[X]) & 0xff) | (this.p ? 0x100 : 0), 0];
        }
        case ABX: {
          // absolute indexed on x
          let adr = this.mem.read(this.br[PC]++);
          adr |= this.mem.read(this.br[PC]++) << 8;
          return [(adr + this.r[X]) & 0xffff, 0];
        }
        case ABY: {
          // absolute indexed on y
          let adr = this.mem.read(this.br[PC]++);
          adr |= this.mem.read(this.br[PC]++) << 8;
          return [(adr + this.r[Y]) & 0xffff, 0];
        }
        case IDY: {
          // indirect indexed direct
          let pointer = this.mem.read(this.br[PC]++);
          let adr = this.mem.read(pointer | (this.p ? 0x100 : 0));
          adr |= this.mem.read(
            ((pointer + 1) & 0xff) | (this.p ? 0x100 : 0)
          ) << 8;
          return [(adr + this.r[Y]) & 0xffff, 0];
        }
        case DD: {
          // direct page to direct page
          let adr = this.mem.read(this.br[PC]++);
          let adr2 = this.mem.read(this.br[PC]++);
          return [adr | (this.p ? 0x100 : 0), adr2 | (this.p ? 0x100 : 0)];
        }
        case II: {
          // indirect to indirect
          return [
            this.r[Y] | (this.p ? 0x100 : 0),
            this.r[X] | (this.p ? 0x100 : 0)
          ];
        }
        case DI: {
          // immediate to direct page
          let imm = this.br[PC]++;
          let adr = this.mem.read(this.br[PC]++);
          return [imm, adr | (this.p ? 0x100 : 0)];
        }
        case DPY: {
          // direct page indexed on y
          let adr = this.mem.read(this.br[PC]++);
          return [((adr + this.r[Y]) & 0xff) | (this.p ? 0x100 : 0), 0];
        }
        case ABB: {
          // absolute, with bit index
          let adr = this.mem.read(this.br[PC]++);
          adr |= this.mem.read(this.br[PC]++) << 8;
          return [adr & 0x1fff, adr >> 13];
        }
        case DXR: {
          // direct page indexed on x, relative
          let adr = this.mem.read(this.br[PC]++);
          let rel = this.getSigned(this.mem.read(this.br[PC]++));
          return [((adr + this.r[X]) & 0xff) | (this.p ? 0x100 : 0), rel];
        }
        case IAX: {
          // indirect absolute indexed
          let adr = this.mem.read(this.br[PC]++);
          adr |= this.mem.read(this.br[PC]++) << 8;
          let radr = this.mem.read((adr + this.r[X]) & 0xffff);
          radr |= this.mem.read((adr + this.r[X] + 1) & 0xffff) << 8;
          return [radr, 0];
        }
        case IPI: {
          // indirect post increment
          return [this.r[X]++ | (this.p ? 0x100 : 0), 0];
        }
      }
    }

    // instructions

    this.nop = function(adr, adrh, instr) {
      // do nothing
    }

    this.clrp = function(adr, adrh, instr) {
      this.p = false;
    }

    this.setp = function(adr, adrh, instr) {
      this.p = true;
    }

    this.clrc = function(adr, adrh, instr) {
      this.c = false;
    }

    this.setc = function(adr, adrh, instr) {
      this.c = true;
    }

    this.ei = function(adr, adrh, instr) {
      this.i = true;
    }

    this.di = function(adr, adrh, instr) {
      this.i = false;
    }

    this.clrv = function(adr, adrh, instr) {
      this.v = false;
      this.h = false;
    }

    this.bpl = function(adr, adrh, instr) {
      this.doBranch(!this.n, adr);
    }

    this.bmi = function(adr, adrh, instr) {
      this.doBranch(this.n, adr);
    }

    this.bvc = function(adr, adrh, instr) {
      this.doBranch(!this.v, adr);
    }

    this.bvs = function(adr, adrh, instr) {
      this.doBranch(this.v, adr);
    }

    this.bcc = function(adr, adrh, instr) {
      this.doBranch(!this.c, adr);
    }

    this.bcs = function(adr, adrh, instr) {
      this.doBranch(this.c, adr);
    }

    this.bne = function(adr, adrh, instr) {
      this.doBranch(!this.z, adr);
    }

    this.beq = function(adr, adrh, instr) {
      this.doBranch(this.z, adr);
    }

    this.tcall = function(adr, adrh, instr) {
      this.push(this.br[PC] >> 8);
      this.push(this.br[PC] & 0xff);
      let padr = 0xffc0 + ((15 - (instr >> 4)) << 1);
      this.br[PC] = this.mem.read(padr) | (this.mem.read(padr + 1) << 8);
    }

    this.set1 = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      value |= (1 << (instr >> 5));
      this.mem.write(adr, value);
    }

    this.clr1 = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      value &= ~(1 << (instr >> 5));
      this.mem.write(adr, value);
    }

    this.bbs = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      this.doBranch((value & (1 << (instr >> 5))) > 0, adrh);
    }

    this.bbc = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      this.doBranch((value & (1 << (instr >> 5))) === 0, adrh);
    }

    this.or = function(adr, adrh, instr) {
      this.r[A] |= this.mem.read(adr);
      this.setZandN(this.r[A]);
    }

    this.orm = function(adr, adrh, instr) {
      let value = this.mem.read(adrh);
      value |= this.mem.read(adr);
      this.mem.write(adrh, value);
      this.setZandN(value);
    }

    this.and = function(adr, adrh, instr) {
      this.r[A] &= this.mem.read(adr);
      this.setZandN(this.r[A]);
    }

    this.andm = function(adr, adrh, instr) {
      let value = this.mem.read(adrh);
      value &= this.mem.read(adr);
      this.mem.write(adrh, value);
      this.setZandN(value);
    }

    this.eor = function(adr, adrh, instr) {
      this.r[A] ^= this.mem.read(adr);
      this.setZandN(this.r[A]);
    }

    this.eorm = function(adr, adrh, instr) {
      let value = this.mem.read(adrh);
      value ^= this.mem.read(adr);
      this.mem.write(adrh, value);
      this.setZandN(value);
    }

    this.cmp = function(adr, adrh, instr) {
      let value = this.mem.read(adr) ^ 0xff;
      let result = this.r[A] + value + 1;
      this.c = result > 0xff;
      this.setZandN(result);
    }

    this.cmpm = function(adr, adrh, instr) {
      let value = this.mem.read(adrh);
      let result = value + (this.mem.read(adr) ^ 0xff) + 1;
      this.c = result > 0xff;
      this.setZandN(result);
    }

    this.cmpx = function(adr, adrh, instr) {
      let value = this.mem.read(adr) ^ 0xff;
      let result = this.r[X] + value + 1;
      this.c = result > 0xff;
      this.setZandN(result);
    }

    this.cmpy = function(adr, adrh, instr) {
      let value = this.mem.read(adr) ^ 0xff;
      let result = this.r[Y] + value + 1;
      this.c = result > 0xff;
      this.setZandN(result);
    }

    this.adc = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      let result = this.r[A] + value + (this.c ? 1 : 0);
      this.v = (
        (this.r[A] & 0x80) === (value & 0x80) &&
        (value & 0x80) !== (result & 0x80)
      );
      this.h = ((this.r[A] & 0xf) + (value & 0xf) + (this.c ? 1 : 0)) > 0xf;
      this.c = result > 0xff;
      this.setZandN(result);
      this.r[A] = result;
    }

    this.adcm = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      let addedTo = this.mem.read(adrh);
      let result = addedTo + value + (this.c ? 1 : 0);
      this.v = (
        (addedTo & 0x80) === (value & 0x80) &&
        (value & 0x80) !== (result & 0x80)
      );
      this.h = ((addedTo & 0xf) + (value & 0xf) + (this.c ? 1 : 0)) > 0xf;
      this.c = result > 0xff;
      this.setZandN(result);
      this.mem.write(adrh, result & 0xff);
    }

    this.sbc = function(adr, adrh, instr) {
      let value = this.mem.read(adr) ^ 0xff;
      let result = this.r[A] + value + (this.c ? 1 : 0);
      this.v = (
        (this.r[A] & 0x80) === (value & 0x80) &&
        (value & 0x80) !== (result & 0x80)
      );
      this.h = ((this.r[A] & 0xf) + (value & 0xf) + (this.c ? 1 : 0)) > 0xf;
      this.c = result > 0xff;
      this.setZandN(result);
      this.r[A] = result;
    }

    this.sbcm = function(adr, adrh, instr) {
      let value = this.mem.read(adr) ^ 0xff;
      let addedTo = this.mem.read(adrh);
      let result = addedTo + value + (this.c ? 1 : 0);
      this.v = (
        (addedTo & 0x80) === (value & 0x80) &&
        (value & 0x80) !== (result & 0x80)
      );
      this.h = ((addedTo & 0xf) + (value & 0xf) + (this.c ? 1 : 0)) > 0xf;
      this.c = result > 0xff;
      this.setZandN(result);
      this.mem.write(adrh, result & 0xff);
    }

    this.movs = function(adr, adrh, instr) {
      if(instr !== 0xaf) {
        // MOV (X+), A does not do a dummy read
        this.mem.read(adr);
      }
      this.mem.write(adr, this.r[A]);
    }

    this.movsx = function(adr, adrh, instr) {
      this.mem.read(adr);
      this.mem.write(adr, this.r[X]);
    }

    this.movsy = function(adr, adrh, instr) {
      this.mem.read(adr);
      this.mem.write(adr, this.r[Y]);
    }

    this.mov = function(adr, adrh, instr) {
      this.r[A] = this.mem.read(adr);
      this.setZandN(this.r[A]);
    }

    this.movx = function(adr, adrh, instr) {
      this.r[X] = this.mem.read(adr);
      this.setZandN(this.r[X]);
    }

    this.movy = function(adr, adrh, instr) {
      this.r[Y] = this.mem.read(adr);
      this.setZandN(this.r[Y]);
    }

    this.or1 = function(adr, adrh, instr) {
      let bit = (this.mem.read(adr) >> adrh) & 0x1;
      let result = (this.c ? 1 : 0) | bit;
      this.c = result > 0;
    }

    this.or1n = function(adr, adrh, instr) {
      let bit = (this.mem.read(adr) >> adrh) & 0x1;
      let result = (this.c ? 1 : 0) | (bit > 0 ? 0 : 1);
      this.c = result > 0;
    }

    this.and1 = function(adr, adrh, instr) {
      let bit = (this.mem.read(adr) >> adrh) & 0x1;
      let result = (this.c ? 1 : 0) & bit;
      this.c = result > 0;
    }

    this.and1n = function(adr, adrh, instr) {
      let bit = (this.mem.read(adr) >> adrh) & 0x1;
      let result = (this.c ? 1 : 0) & (bit > 0 ? 0 : 1);
      this.c = result > 0;
    }

    this.eor1 = function(adr, adrh, instr) {
      let bit = (this.mem.read(adr) >> adrh) & 0x1;
      let result = (this.c ? 1 : 0) ^ bit;
      this.c = result > 0;
    }

    this.mov1 = function(adr, adrh, instr) {
      let bit = (this.mem.read(adr) >> adrh) & 0x1;
      this.c = bit > 0;
    }

    this.mov1s = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      let bit = 1 << adrh;
      value = this.c ? (value | bit) : (value & ~bit);
      this.mem.write(adr, value);
    }

    this.not1 = function(adr, adrh, instr) {
      let bit = 1 << adrh;
      let value = this.mem.read(adr) ^ bit;
      this.mem.write(adr, value);
    }

    this.decw = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      value |= this.mem.read(adrh) << 8;
      value = (value - 1) & 0xffff;
      this.z = value === 0;
      this.n = (value & 0x8000) > 0;
      this.mem.write(adr, value & 0xff);
      this.mem.write(adrh, value >> 8);
    }

    this.incw = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      value |= this.mem.read(adrh) << 8;
      value = (value + 1) & 0xffff;
      this.z = value === 0;
      this.n = (value & 0x8000) > 0;
      this.mem.write(adr, value & 0xff);
      this.mem.write(adrh, value >> 8);
    }

    this.cmpw = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      value |= this.mem.read(adrh) << 8;
      let addTo = (this.r[Y] << 8) | this.r[A];
      let result = addTo + (value ^ 0xffff) + 1;
      this.z = (result & 0xffff) === 0;
      this.n = (result & 0x8000) > 0;
      this.c = result > 0xffff;
    }

    this.addw = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      value |= this.mem.read(adrh) << 8;
      let addTo = (this.r[Y] << 8) | this.r[A];
      let result = addTo + value;
      this.z = (result & 0xffff) === 0;
      this.n = (result & 0x8000) > 0;
      this.c = result > 0xffff;
      this.v = (
        (addTo & 0x8000) === (value & 0x8000) &&
        (value & 0x8000) !== (result & 0x8000)
      );
      this.h = ((addTo & 0xfff) + (value & 0xfff)) > 0x0fff;
      this.r[A] = result & 0xff;
      this.r[Y] = (result & 0xff00) >> 8;
    }

    this.subw = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      value |= this.mem.read(adrh) << 8;
      value ^= 0xffff;
      let addTo = (this.r[Y] << 8) | this.r[A];
      let result = addTo + value + 1;
      this.z = (result & 0xffff) === 0;
      this.n = (result & 0x8000) > 0;
      this.c = result > 0xffff;
      this.v = (
        (addTo & 0x8000) === (value & 0x8000) &&
        (value & 0x8000) !== (result & 0x8000)
      );
      this.h = ((addTo & 0xfff) + (value & 0xfff) + 1) > 0xfff;
      this.r[A] = result & 0xff;
      this.r[Y] = (result & 0xff00) >> 8;
    }

    this.movw = function(adr, adrh, instr) {
      this.r[A] = this.mem.read(adr);
      this.r[Y] = this.mem.read(adrh);
      this.z = this.r[A] === 0 && this.r[Y] === 0;
      this.n = (this.r[Y] & 0x80) > 0;
    }

    this.movws = function(adr, adrh, instr) {
      this.mem.read(adr);
      this.mem.write(adr, this.r[A]);
      this.mem.write(adrh, this.r[Y]);
    }

    this.movm = function(adr, adrh, instr) {
      if(instr === 0x8f) {
        // MOV $dd, #$ii does a dummy read, MOV $dd, $dd does not
        this.mem.read(adrh);
      }
      this.mem.write(adrh, this.mem.read(adr));
    }

    this.asl = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      this.c = (value & 0x80) > 0;
      value <<= 1;
      this.setZandN(value);
      this.mem.write(adr, value & 0xff);
    }

    this.asla = function(adr, adrh, instr) {
      this.c = (this.r[A] & 0x80) > 0;
      this.r[A] <<= 1;
      this.setZandN(this.r[A]);
    }

    this.rol = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      let carry = (value & 0x80) > 0;
      value = (value << 1) | (this.c ? 1 : 0);
      this.c = carry > 0;
      this.setZandN(value);
      this.mem.write(adr, value & 0xff);
    }

    this.rola = function(adr, adrh, instr) {
      let carry = (this.r[A] & 0x80) > 0;
      this.r[A] = (this.r[A] << 1) | (this.c ? 1 : 0);
      this.c = carry > 0;
      this.setZandN(this.r[A]);
    }

    this.lsr = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      this.c = (value & 0x1) > 0;
      value >>= 1;
      this.setZandN(value);
      this.mem.write(adr, value & 0xff);
    }

    this.lsra = function(adr, adrh, instr) {
      this.c = (this.r[A] & 0x1) > 0;
      this.r[A] >>= 1;
      this.setZandN(this.r[A]);
    }

    this.ror = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      let carry = (value & 0x1) > 0;
      value = (value >> 1) | (this.c ? 0x80 : 0);
      this.c = carry > 0;
      this.setZandN(value);
      this.mem.write(adr, value & 0xff);
    }

    this.rora = function(adr, adrh, instr) {
      let carry = (this.r[A] & 0x1) > 0;
      this.r[A] = (this.r[A] >> 1) | (this.c ? 0x80 : 0);
      this.c = carry > 0;
      this.setZandN(this.r[A]);
    }

    this.inc = function(adr, adrh, instr) {
      let value = (this.mem.read(adr) + 1) & 0xff;
      this.setZandN(value);
      this.mem.write(adr, value);
    }

    this.inca = function(adr, adrh, instr) {
      this.r[A]++;
      this.setZandN(this.r[A]);
    }

    this.incx = function(adr, adrh, instr) {
      this.r[X]++;
      this.setZandN(this.r[X]);
    }

    this.incy = function(adr, adrh, instr) {
      this.r[Y]++;
      this.setZandN(this.r[Y]);
    }

    this.dec = function(adr, adrh, instr) {
      let value = (this.mem.read(adr) - 1) & 0xff;
      this.setZandN(value);
      this.mem.write(adr, value);
    }

    this.deca = function(adr, adrh, instr) {
      this.r[A]--;
      this.setZandN(this.r[A]);
    }

    this.decx = function(adr, adrh, instr) {
      this.r[X]--;
      this.setZandN(this.r[X]);
    }

    this.decy = function(adr, adrh, instr) {
      this.r[Y]--;
      this.setZandN(this.r[Y]);
    }

    this.pushp = function(adr, adrh, instr) {
      this.push(this.getP());
    }

    this.pusha = function(adr, adrh, instr) {
      this.push(this.r[A]);
    }

    this.pushx = function(adr, adrh, instr) {
      this.push(this.r[X]);
    }

    this.pushy = function(adr, adrh, instr) {
      this.push(this.r[Y]);
    }

    this.movxa = function(adr, adrh, instr) {
      this.r[X] = this.r[A];
      this.setZandN(this.r[X]);
    }

    this.movax = function(adr, adrh, instr) {
      this.r[A] = this.r[X];
      this.setZandN(this.r[A]);
    }

    this.movxp = function(adr, adrh, instr) {
      this.r[X] = this.r[SP];
      this.setZandN(this.r[X]);
    }

    this.movpx = function(adr, adrh, instr) {
      this.r[SP] = this.r[X];
    }

    this.movay = function(adr, adrh, instr) {
      this.r[A] = this.r[Y];
      this.setZandN(this.r[A]);
    }

    this.movya = function(adr, adrh, instr) {
      this.r[Y] = this.r[A];
      this.setZandN(this.r[Y]);
    }

    this.notc = function(adr, adrh, instr) {
      this.c = !this.c;
    }

    this.tset1 = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      let result = this.r[A] + (value ^ 0xff) + 1;
      this.setZandN(result);
      value |= this.r[A];
      this.mem.write(adr, value);
    }

    this.tclr1 = function(adr, adrh, instr) {
      let value = this.mem.read(adr);
      let result = this.r[A] + (value ^ 0xff) + 1;
      this.setZandN(result);
      value &= ~this.r[A];
      this.mem.write(adr, value);
    }

    this.cbne = function(adr, adrh, instr) {
      let value = this.mem.read(adr) ^ 0xff;
      let result = this.r[A] + value + 1;
      this.doBranch((result & 0xff) !== 0, adrh);
    }

    this.dbnz = function(adr, adrh, instr) {
      let value = (this.mem.read(adr) - 1) & 0xff;
      this.mem.write(adr, value);
      this.doBranch(value !== 0, adrh);
    }

    this.dbnzy = function(adr, adrh, instr) {
      this.r[Y]--;
      this.doBranch(this.r[Y] !== 0, adr);
    }

    this.popp = function(adr, adrh, instr) {
      this.setP(this.pop());
    }

    this.popa = function(adr, adrh, instr) {
      this.r[A] = this.pop();
    }

    this.popx = function(adr, adrh, instr) {
      this.r[X] = this.pop();
    }

    this.popy = function(adr, adrh, instr) {
      this.r[Y] = this.pop();
    }

    this.brk = function(adr, adrh, instr) {
      this.push(this.br[PC] >> 8);
      this.push(this.br[PC] & 0xff);
      this.push(this.getP());
      this.i = false;
      this.b = true;
      this.br[PC] = this.mem.read(0xffde) | (this.mem.read(0xffdf) << 8);
    }

    this.jmp = function(adr, adrh, instr) {
      this.br[PC] = adr;
    }

    this.bra = function(adr, adrh, instr) {
      this.br[PC] += adr;
    }

    this.call = function(adr, adrh, instr) {
      this.push(this.br[PC] >> 8);
      this.push(this.br[PC] & 0xff);
      this.br[PC] = adr;
    }

    this.pcall = function(adr, adrh, instr) {
      this.push(this.br[PC] >> 8);
      this.push(this.br[PC] & 0xff);
      this.br[PC] = 0xff00 + (adr & 0xff);
    }

    this.ret = function(adr, adrh, instr) {
      this.br[PC] = this.pop();
      this.br[PC] |= this.pop() << 8;
    }

    this.reti = function(adr, adrh, instr) {
      this.setP(this.pop());
      this.br[PC] = this.pop();
      this.br[PC] |= this.pop() << 8;
    }

    this.xcn = function(adr, adrh, instr) {
      this.r[A] = (this.r[A] >> 4) | (this.r[A] << 4);
      this.setZandN(this.r[A]);
    }

    this.sleep = function(adr, adrh, instr) {
      // interrupts are not supported on the spc in the snes, so act like stop
      this.br[PC]--;
    }

    this.stop = function(adr, adrh, instr) {
      this.br[PC]--;
    }

    this.mul = function(adr, adrh, instr) {
      let result = this.r[Y] * this.r[A];
      this.r[A] = result & 0xff;
      this.r[Y] = (result & 0xff00) >> 8;
      this.setZandN(this.r[Y]);
    }

    this.div = function(adr, adrh, instr) {
      let value = this.r[A] | (this.r[Y] << 8);
      let result = 0xffff;
      let mod = value & 0xff;
      if(this.r[X] !== 0) {
        result = (value / this.r[X]) & 0xffff;
        mod = value % this.r[X];
      }
      this.v = result > 0xff;
      this.h = (this.r[X] & 0xf) <= (this.r[Y] & 0xf);
      this.r[A] = result;
      this.r[Y] = mod;
      this.setZandN(this.r[A]);
    }

    this.daa = function(adr, adrh, instr) {
      if(this.r[A] > 0x99 || this.c) {
        this.r[A] += 0x60;
        this.c = true;
      }
      if((this.r[A] & 0xf) > 9 || this.h) {
        this.r[A] += 6;
      }
      this.setZandN(this.r[A]);
    }

    this.das = function(adr, adrh, instr) {
      if(this.r[A] > 0x99 || !this.c) {
        this.r[A] -= 0x60;
        this.c = false;
      }
      if((this.r[A] & 0xf) > 9 || !this.h) {
        this.r[A] -= 6;
      }
      this.setZandN(this.r[A]);
    }

    // function table

    this.functions = [
      this.nop , this.tcall,this.set1, this.bbs , this.or  , this.or  , this.or  , this.or  , this.or  , this.orm , this.or1 , this.asl , this.asl , this.pushp,this.tset1,this.brk ,
      this.bpl , this.tcall,this.clr1, this.bbc , this.or  , this.or  , this.or  , this.or  , this.orm , this.orm , this.decw, this.asl , this.asla, this.decx, this.cmpx, this.jmp ,
      this.clrp, this.tcall,this.set1, this.bbs , this.and , this.and , this.and , this.and , this.and , this.andm, this.or1n, this.rol , this.rol , this.pusha,this.cbne, this.bra ,
      this.bmi , this.tcall,this.clr1, this.bbc , this.and , this.and , this.and , this.and , this.andm, this.andm, this.incw, this.rol , this.rola, this.incx, this.cmpx, this.call,
      this.setp, this.tcall,this.set1, this.bbs , this.eor , this.eor , this.eor , this.eor , this.eor , this.eorm, this.and1, this.lsr , this.lsr , this.pushx,this.tclr1,this.pcall,
      this.bvc , this.tcall,this.clr1, this.bbc , this.eor , this.eor , this.eor , this.eor , this.eorm, this.eorm, this.cmpw, this.lsr , this.lsra, this.movxa,this.cmpy, this.jmp ,
      this.clrc, this.tcall,this.set1, this.bbs , this.cmp , this.cmp , this.cmp , this.cmp , this.cmp , this.cmpm, this.and1n,this.ror , this.ror , this.pushy,this.dbnz, this.ret ,
      this.bvs , this.tcall,this.clr1, this.bbc , this.cmp , this.cmp , this.cmp , this.cmp , this.cmpm, this.cmpm, this.addw, this.ror , this.rora, this.movax,this.cmpy, this.reti,
      this.setc, this.tcall,this.set1, this.bbs , this.adc , this.adc , this.adc , this.adc , this.adc , this.adcm, this.eor1, this.dec , this.dec , this.movy, this.popp, this.movm,
      this.bcc , this.tcall,this.clr1, this.bbc , this.adc , this.adc , this.adc , this.adc , this.adcm, this.adcm, this.subw, this.dec , this.deca, this.movxp,this.div , this.xcn ,
      this.ei  , this.tcall,this.set1, this.bbs , this.sbc , this.sbc , this.sbc , this.sbc , this.sbc , this.sbcm, this.mov1, this.inc , this.inc , this.cmpy, this.popa, this.movs,
      this.bcs , this.tcall,this.clr1, this.bbc , this.sbc , this.sbc , this.sbc , this.sbc , this.sbcm, this.sbcm, this.movw, this.inc , this.inca, this.movpx,this.das , this.mov ,
      this.di  , this.tcall,this.set1, this.bbs , this.movs, this.movs, this.movs, this.movs, this.cmpx, this.movsx,this.mov1s,this.movsy,this.movsy,this.movx, this.popx, this.mul ,
      this.bne , this.tcall,this.clr1, this.bbc , this.movs, this.movs, this.movs, this.movs, this.movsx,this.movsx,this.movws,this.movsy,this.decy, this.movay,this.cbne, this.daa ,
      this.clrv, this.tcall,this.set1, this.bbs , this.mov , this.mov , this.mov , this.mov , this.mov , this.movx, this.not1, this.movy, this.movy, this.notc, this.popy, this.sleep,
      this.beq , this.tcall,this.clr1, this.bbc , this.mov , this.mov , this.mov , this.mov , this.movx, this.movx, this.movm, this.movy, this.incy, this.movya,this.dbnzy,this.stop
    ];

  }

})();

function Apu(snes) {

  this.snes = snes;

  this.spc = new Spc(this);
  this.dsp = new Dsp(this);

  this.bootRom = new Uint8Array([
    0xcd, 0xef, 0xbd, 0xe8, 0x00, 0xc6, 0x1d, 0xd0, 0xfc, 0x8f, 0xaa, 0xf4, 0x8f, 0xbb, 0xf5, 0x78,
    0xcc, 0xf4, 0xd0, 0xfb, 0x2f, 0x19, 0xeb, 0xf4, 0xd0, 0xfc, 0x7e, 0xf4, 0xd0, 0x0b, 0xe4, 0xf5,
    0xcb, 0xf4, 0xd7, 0x00, 0xfc, 0xd0, 0xf3, 0xab, 0x01, 0x10, 0xef, 0x7e, 0xf4, 0x10, 0xeb, 0xba,
    0xf6, 0xda, 0x00, 0xba, 0xf4, 0xc4, 0xf4, 0xdd, 0x5d, 0xd0, 0xdb, 0x1f, 0x00, 0x00, 0xc0, 0xff
  ]);

  this.ram = new Uint8Array(0x10000);

  this.spcWritePorts = new Uint8Array(4);
  this.spcReadPorts = new Uint8Array(6); // includes 2 bytes of 'ram'

  this.reset = function() {
    clearArray(this.ram);
    clearArray(this.spcWritePorts);
    clearArray(this.spcReadPorts);

    this.dspAdr = 0;
    this.dspRomReadable = true;

    this.spc.reset();
    this.dsp.reset();

    this.cycles = 0;

    // timers
    this.timer1int = 0;
    this.timer1div = 0;
    this.timer1target = 0;
    this.timer1counter = 0;
    this.timer1enabled = false;
    this.timer2int = 0;
    this.timer2div = 0;
    this.timer2target = 0;
    this.timer2counter = 0;
    this.timer2enabled = false;
    this.timer3int = 0;
    this.timer3div = 0;
    this.timer3target = 0;
    this.timer3counter = 0;
    this.timer3enabled = false;
  }
  this.reset();

  this.cycle = function() {
    this.spc.cycle();

    if((this.cycles & 0x1f) === 0) {
      // every 32 cycles
      this.dsp.cycle();
    }

    // run the timers
    if(this.timer1int === 0) {
      this.timer1int = 128;
      if(this.timer1enabled) {
        this.timer1div++;
        this.timer1div &= 0xff;
        if(this.timer1div === this.timer1target) {
          this.timer1div = 0;
          this.timer1counter++;
          this.timer1counter &= 0xf;
        }
      }
    }
    this.timer1int--;

    if(this.timer2int === 0) {
      this.timer2int = 128;
      if(this.timer2enabled) {
        this.timer2div++;
        this.timer2div &= 0xff;
        if(this.timer2div === this.timer2target) {
          this.timer2div = 0;
          this.timer2counter++;
          this.timer2counter &= 0xf;
        }
      }
    }
    this.timer2int--;

    if(this.timer3int === 0) {
      this.timer3int = 16;
      if(this.timer3enabled) {
        this.timer3div++;
        this.timer3div &= 0xff;
        if(this.timer3div === this.timer3target) {
          this.timer3div = 0;
          this.timer3counter++;
          this.timer3counter &= 0xf;
        }
      }
    }
    this.timer3int--;

    this.cycles++;
  }

  this.read = function(adr) {
    adr &= 0xffff;

    switch(adr) {
      case 0xf0:
      case 0xf1:
      case 0xfa:
      case 0xfb:
      case 0xfc: {
        // not readable
        return 0;
      }
      case 0xf2: {
        return this.dspAdr;
      }
      case 0xf3: {
        return this.dsp.read(this.dspAdr & 0x7f);
      }
      case 0xf4:
      case 0xf5:
      case 0xf6:
      case 0xf7:
      case 0xf8:
      case 0xf9: {
        return this.spcReadPorts[adr - 0xf4];
      }
      case 0xfd: {
        let val = this.timer1counter;
        this.timer1counter = 0;
        return val;
      }
      case 0xfe: {
        let val = this.timer2counter;
        this.timer2counter = 0;
        return val;
      }
      case 0xff: {
        let val = this.timer3counter;
        this.timer3counter = 0;
        return val;
      }
    }

    if(adr >= 0xffc0 && this.dspRomReadable) {
      return this.bootRom[adr & 0x3f];
    }

    return this.ram[adr];
  }

  this.write = function(adr, value) {
    adr &= 0xffff;

    switch(adr) {
      case 0xf0: {
        // test register, not emulated
        break;
      }
      case 0xf1: {
        if(!this.timer1enabled && (value & 0x01) > 0) {
          this.timer1div = 0;
          this.timer1counter = 0;
        }
        if(!this.timer2enabled && (value & 0x02) > 0) {
          this.timer2div = 0;
          this.timer2counter = 0;
        }
        if(!this.timer3enabled && (value & 0x04) > 0) {
          this.timer3div = 0;
          this.timer3counter = 0;
        }
        this.timer1enabled = (value & 0x01) > 0;
        this.timer2enabled = (value & 0x02) > 0;
        this.timer3enabled = (value & 0x04) > 0;
        this.dspRomReadable = (value & 0x80) > 0;
        if((value & 0x10) > 0) {
          this.spcReadPorts[0] = 0;
          this.spcReadPorts[1] = 0;
        }
        if((value & 0x20) > 0) {
          this.spcReadPorts[2] = 0;
          this.spcReadPorts[3] = 0;
        }
        break;
      }
      case 0xf2: {
        this.dspAdr = value;
        break;
      }
      case 0xf3: {
        if(this.dspAdr < 0x80) {
          this.dsp.write(this.dspAdr, value);
        }
        break;
      }
      case 0xf4:
      case 0xf5:
      case 0xf6:
      case 0xf7: {
        this.spcWritePorts[adr - 0xf4] = value;
        break;
      }
      case 0xf8:
      case 0xf9: {
        this.spcReadPorts[adr - 0xf4] = value;
      }
      case 0xfa: {
        this.timer1target = value;
        break;
      }
      case 0xfb: {
        this.timer2target = value;
        break;
      }
      case 0xfc: {
        this.timer3target = value;
        break;
      }
    }

    this.ram[adr] = value;
  }

  this.setSamples = function(left, right, sampleCount) {
    let add = 534 / sampleCount;
    let total = 0;
    for(let i = 0; i < sampleCount; i++) {
      left[i] =  this.dsp.samplesL[total & 0xffff];
      right[i] =  this.dsp.samplesR[total & 0xffff];
      total += add;
    }
    this.dsp.sampleOffset = 0;
  }
}

function Ppu(snes) {

  this.snes = snes;

  this.vram = new Uint16Array(0x8000);

  this.cgram = new Uint16Array(0x100);

  this.oam = new Uint16Array(0x100);
  this.highOam = new Uint16Array(0x10);

  this.spriteLineBuffer = new Uint8Array(256);
  this.spritePrioBuffer = new Uint8Array(256);

  this.mode7Xcoords = new Int32Array(256);
  this.mode7Ycoords = new Int32Array(256);

  this.pixelOutput = new Uint16Array(512*3*240);

  this.layersPerMode = [
    4, 0, 1, 4, 0, 1, 4, 2, 3, 4, 2, 3,
    4, 0, 1, 4, 0, 1, 4, 2, 4, 2, 5, 5,
    4, 0, 4, 1, 4, 0, 4, 1, 5, 5, 5, 5,
    4, 0, 4, 1, 4, 0, 4, 1, 5, 5, 5, 5,
    4, 0, 4, 1, 4, 0, 4, 1, 5, 5, 5, 5,
    4, 0, 4, 1, 4, 0, 4, 1, 5, 5, 5, 5,
    4, 0, 4, 4, 0, 4, 5, 5, 5, 5, 5, 5,
    4, 4, 4, 0, 4, 5, 5, 5, 5, 5, 5, 5,
    2, 4, 0, 1, 4, 0, 1, 4, 2, 4, 5, 5,
    4, 4, 1, 4, 0, 4, 1, 5, 5, 5, 5, 5
  ];

  this.prioPerMode = [
    3, 1, 1, 2, 0, 0, 1, 1, 1, 0, 0, 0,
    3, 1, 1, 2, 0, 0, 1, 1, 0, 0, 5, 5,
    3, 1, 2, 1, 1, 0, 0, 0, 5, 5, 5, 5,
    3, 1, 2, 1, 1, 0, 0, 0, 5, 5, 5, 5,
    3, 1, 2, 1, 1, 0, 0, 0, 5, 5, 5, 5,
    3, 1, 2, 1, 1, 0, 0, 0, 5, 5, 5, 5,
    3, 1, 2, 1, 0, 0, 5, 5, 5, 5, 5, 5,
    3, 2, 1, 0, 0, 5, 5, 5, 5, 5, 5, 5,
    1, 3, 1, 1, 2, 0, 0, 1, 0, 0, 5, 5,
    3, 2, 1, 1, 0, 0, 0, 5, 5, 5, 5, 5
  ];

  this.bitPerMode = [
    2, 2, 2, 2,
    4, 4, 2, 5,
    4, 4, 5, 5,
    8, 4, 5, 5,
    8, 2, 5, 5,
    4, 2, 5, 5,
    4, 5, 5, 5,
    8, 5, 5, 5,
    4, 4, 2, 5,
    8, 7, 5, 5
  ];

  this.layercountPerMode = [12, 10, 8, 8, 8, 8, 6, 5, 10, 7];

  this.brightnessMults = [
    0.1, 0.5, 1.1, 1.6, 2.2, 2.7, 3.3, 3.8, 4.4, 4.9, 5.5, 6, 6.6, 7.1, 7.6, 8.2
  ];

  this.spriteTileOffsets = [
    0, 1, 2, 3, 4, 5, 6, 7,
    16, 17, 18, 19, 20, 21, 22, 23,
    32, 33, 34, 35, 36, 37, 38, 39,
    48, 49, 50, 51, 52, 53, 54, 55,
    64, 65, 66, 67, 68, 69, 70, 71,
    80, 81, 82, 83, 84, 85, 86, 87,
    96, 97, 98, 99, 100, 101, 102, 103,
    112, 113, 114, 115, 116, 117, 118, 119
  ];

  this.spriteSizes = [
    1, 1, 1, 2, 2, 4, 2, 2,
    2, 4, 8, 4, 8, 8, 4, 4
  ];

  this.reset = function() {

    clearArray(this.vram);
    clearArray(this.cgram);
    clearArray(this.oam);
    clearArray(this.highOam);

    clearArray(this.spriteLineBuffer);
    clearArray(this.spritePrioBuffer);

    clearArray(this.pixelOutput);

    clearArray(this.mode7Xcoords);
    clearArray(this.mode7Ycoords);

    this.cgramAdr = 0;
    this.cgramSecond = false;
    this.cgramBuffer = 0;

    this.vramInc = 0;
    this.vramRemap = 0;
    this.vramIncOnHigh = false;
    this.vramAdr = 0;
    this.vramReadBuffer = 0;

    this.tilemapWider = [false, false, false, false];
    this.tilemapHigher = [false, false, false, false];
    this.tilemapAdr = [0, 0, 0, 0];
    this.tileAdr = [0, 0, 0, 0];

    this.bgHoff = [0, 0, 0, 0, 0];
    this.bgVoff = [0, 0, 0, 0, 0];
    this.offPrev1 = 0;
    this.offPrev2 = 0;

    this.mode = 0;
    this.layer3Prio = false;
    this.bigTiles = [false, false, false, false];

    this.mosaicEnabled = [false, false, false, false, false];
    this.mosaicSize = 1;
    this.mosaicStartLine = 1;

    this.mainScreenEnabled = [false, false, false, false, false];
    this.subScreenEnabled = [false, false, false, false, false];

    this.forcedBlank = true;
    this.brightness = 0;

    this.oamAdr = 0;
    this.oamRegAdr = 0;
    this.oamInHigh = false;
    this.oamRegInHigh = false;
    this.objPriority = false;
    this.oamSecond = false;
    this.oamBuffer = false;

    this.sprAdr1 = 0;
    this.sprAdr2 = 0;
    this.objSize = 0;

    this.rangeOver = false;
    this.timeOver = false;

    this.mode7ExBg = false;
    this.pseudoHires = false;
    this.overscan = false;
    this.objInterlace = false;
    this.interlace = false;

    this.frameOverscan = false;
    this.frameInterlace = false;
    this.evenFrame = false;

    this.latchedHpos = 0;
    this.latchedVpos = 0;
    this.latchHsecond = false;
    this.latchVsecond = false;
    this.countersLatched = false;

    this.mode7Hoff = 0;
    this.mode7Voff = 0;
    this.mode7A = 0;
    this.mode7B = 0;
    this.mode7C = 0;
    this.mode7D = 0;
    this.mode7X = 0;
    this.mode7Y = 0;
    this.mode7Prev = 0;
    this.multResult = 0;

    this.mode7LargeField = false;
    this.mode7Char0fill = false;
    this.mode7FlipX = false;
    this.mode7FlipY = false;

    this.window1Inversed = [false, false, false, false, false, false];
    this.window1Enabled = [false, false, false, false, false, false];
    this.window2Inversed = [false, false, false, false, false, false];
    this.window2Enabled = [false, false, false, false, false, false];
    this.windowMaskLogic = [0, 0, 0, 0, 0, 0];
    this.window1Left = 0;
    this.window1Right = 0;
    this.window2Left = 0;
    this.window2Right = 0;
    this.mainScreenWindow = [false, false, false, false, false];
    this.subScreenWindow = [false, false, false, false, false];

    this.colorClip = 0;
    this.preventMath = 0;
    this.addSub = false;
    this.directColor = false;

    this.subtractColors = false;
    this.halfColors = false;
    this.mathEnabled = [false, false, false, false, false, false];
    this.fixedColorB = 0;
    this.fixedColorG = 0;
    this.fixedColorR = 0;

    this.tilemapBuffer = [0, 0, 0, 0];
    this.tileBufferP1 = [0, 0, 0, 0];
    this.tileBufferP2 = [0, 0, 0, 0];
    this.tileBufferP3 = [0, 0, 0, 0];
    this.tileBufferP4 = [0, 0, 0, 0];
    this.lastTileFetchedX = [-1, -1, -1, -1];
    this.lastTileFetchedY = [-1, -1, -1, -1];
    this.optHorBuffer = [0, 0];
    this.optVerBuffer = [0, 0];
    this.lastOrigTileX = [-1, -1];
  }
  this.reset();

  // TODO: better mode 2/4/6 offset-per-tile (especially mode 6), color math
  // when subscreen is visible (especially how to handle the subscreen pixels),
  // mosaic with hires/interlace, mosaic on mode 7, rectangular sprites,
  // oddities with sprite X-position being -256, mosaic with offset-per-tile,
  // offset-per-tile with interlace, reading/writing ram while rendering

  this.checkOverscan = function(line) {
    if(line === 225 && this.overscan) {
      this.frameOverscan = true;
    }
  }

  this.renderLine = function(line) {
    if(line === 0) {
      // pre-render line
      this.rangeOver = false;
      this.timeOver = false;
      this.frameOverscan = false;
      this.frameInterlace = false;
      clearArray(this.spriteLineBuffer);
      if(!this.forcedBlank) {
        this.evaluateSprites(0);
      }
    } else if(line === (this.frameOverscan ? 240 : 225)) {
      // beginning of Vblank
      if(!this.forcedBlank) {
        this.oamAdr = this.oamRegAdr;
        this.oamInHigh = this.oamRegInHigh;
        this.oamSecond = false;
      }
      this.frameInterlace = this.interlace;
      this.evenFrame = !this.evenFrame;
    } else if(line > 0 && line < (this.frameOverscan ? 240 : 225)) {
      // visible line
      if(line === 1) {
        this.mosaicStartLine = 1;
      }
      if(this.mode === 7) {
        this.generateMode7Coords(line);
      }
      this.lastTileFetchedX = [-1, -1, -1, -1];
      this.lastTileFetchedY = [-1, -1, -1, -1];
      this.optHorBuffer = [0, 0];
      this.optVerBuffer = [0, 0];
      this.lastOrigTileX = [-1, -1];
      let bMult = this.brightnessMults[this.brightness];
      let i = 0;
      while(i < 256) {
        // for each pixel

        let r1 = 0;
        let g1 = 0;
        let b1 = 0;
        let r2 = 0;
        let g2 = 0;
        let b2 = 0;

        if(!this.forcedBlank) {

          let colLay = this.getColor(false, i, line);
          let color = colLay[0];

          r2 = color & 0x1f;
          g2 = (color & 0x3e0) >> 5;
          b2 = (color & 0x7c00) >> 10;

          if(
            this.colorClip === 3 ||
            (this.colorClip === 2 && this.getWindowState(i, 5)) ||
            (this.colorClip === 1 && !this.getWindowState(i, 5))
          ) {
            r2 = 0;
            g2 = 0;
            b2 = 0;
          }

          let secondLay = [0, 5, 0];
          if(
            this.mode === 5 || this.mode === 6 || this.pseudoHires ||
            (this.getMathEnabled(i, colLay[1], colLay[2]) && this.addSub)
          ) {
            secondLay = this.getColor(true, i, line);
            r1 = secondLay[0] & 0x1f;
            g1 = (secondLay[0] & 0x3e0) >> 5;
            b1 = (secondLay[0] & 0x7c00) >> 10;
          }

          if(this.getMathEnabled(i, colLay[1], colLay[2])) {
            if(this.subtractColors) {
              r2 -= (this.addSub && secondLay[1] < 5) ? r1 : this.fixedColorR;
              g2 -= (this.addSub && secondLay[1] < 5) ? g1 : this.fixedColorG;
              b2 -= (this.addSub && secondLay[1] < 5) ? b1 : this.fixedColorB;
            } else {
              r2 += (this.addSub && secondLay[1] < 5) ? r1 : this.fixedColorR;
              g2 += (this.addSub && secondLay[1] < 5) ? g1 : this.fixedColorG;
              b2 += (this.addSub && secondLay[1] < 5) ? b1 : this.fixedColorB;
            }

            if(this.halfColors && (secondLay[1] < 5 || !this.addSub)) {
              r2 >>= 1;
              g2 >>= 1;
              b2 >>= 1;
            }
            r2 = r2 > 31 ? 31 : r2;
            r2 = r2 < 0 ? 0 : r2;
            g2 = g2 > 31 ? 31 : g2;
            g2 = g2 < 0 ? 0 : g2;
            b2 = b2 > 31 ? 31 : b2;
            b2 = b2 < 0 ? 0 : b2;
          }

          if(!(this.mode === 5 || this.mode === 6 || this.pseudoHires)) {
            r1 = r2;
            g1 = g2;
            b1 = b2;
          }

        }
        this.pixelOutput[line * 1536 + 6 * i] = (r1 * bMult) & 0xff;
        this.pixelOutput[line * 1536 + 6 * i + 1] = (g1 * bMult) & 0xff;
        this.pixelOutput[line * 1536 + 6 * i + 2] = (b1 * bMult) & 0xff;
        this.pixelOutput[line * 1536 + 6 * i + 3] = (r2 * bMult) & 0xff;
        this.pixelOutput[line * 1536 + 6 * i + 4] = (g2 * bMult) & 0xff;
        this.pixelOutput[line * 1536 + 6 * i + 5] = (b2 * bMult) & 0xff;

        i++;

      }
      clearArray(this.spriteLineBuffer);
      if(!this.forcedBlank) {
        this.evaluateSprites(line);
      }
    }
  }

  this.getColor = function(sub, x, y) {

    let modeIndex = this.layer3Prio && this.mode === 1 ? 96 : 12 * this.mode;
    modeIndex = this.mode7ExBg && this.mode === 7 ? 108 : modeIndex;
    let count = this.layercountPerMode[this.mode];

    let j;
    let pixel = 0;
    let layer = 5;
    if(this.interlace && (this.mode === 5 || this.mode === 6)) {
      y = y * 2 + (this.evenFrame ? 1 : 0);
    }
    for(j = 0; j < count; j++) {
      let lx = x;
      let ly = y;
      layer = this.layersPerMode[modeIndex + j];
      if(
        (
          !sub && this.mainScreenEnabled[layer] &&
          (!this.mainScreenWindow[layer] || !this.getWindowState(lx, layer))
        ) || (
          sub && this.subScreenEnabled[layer] &&
          (!this.subScreenWindow[layer] || !this.getWindowState(lx, layer))
        )
      ) {
        if(this.mosaicEnabled[layer]) {
          lx -= lx % this.mosaicSize;
          ly -= (ly - this.mosaicStartLine) % this.mosaicSize;
        }
        lx += this.mode === 7 ? 0 : this.bgHoff[layer];
        ly += this.mode === 7 ? 0 : this.bgVoff[layer];
        let optX = lx - this.bgHoff[layer];
        if((this.mode === 5 || this.mode === 6) && layer < 4) {
          lx = lx * 2 + (sub ? 0 : 1);
          optX = optX * 2 + (sub ? 0 : 1);
        }

        //let origLx = lx;

        if((this.mode === 2 || this.mode === 4 || this.mode === 6) && layer < 2) {
          let andVal = layer === 0 ? 0x2000 : 0x4000;
          if(x === 0) {
            this.lastOrigTileX[layer] = lx >> 3;
          }
          // where the relevant tile started
          // TODO: lx can be above 0xffff (e.g. if scroll is 0xffff, and x > 0)
          let tileStartX = optX - (lx - (lx & 0xfff8));
          if((lx >> 3) !== this.lastOrigTileX[layer] && x > 0) {
            // we are fetching a new tile for the layer, get a new OPT-tile
            // if(logging && y === 32 && (this.mode === 2 || this.mode === 4 || this.mode === 6) && layer === 0) {
            //   log("at X = " + x + ", lx: " + getWordRep(lx) + ", fetched new tile for OPT");
            // }
            this.fetchTileInBuffer(
              this.bgHoff[2] + ((tileStartX - 1) & 0x1f8),
              this.bgVoff[2], 2, true
            );
            this.optHorBuffer[layer] = this.tilemapBuffer[2];
            if(this.mode === 4) {
              if((this.optHorBuffer[layer] & 0x8000) > 0) {
                this.optVerBuffer[layer] = this.optHorBuffer[layer];
                this.optHorBuffer[layer] = 0;
              } else {
                this.optVerBuffer[layer] = 0;
              }
            } else {
              this.fetchTileInBuffer(
                this.bgHoff[2] + ((tileStartX - 1) & 0x1f8),
                this.bgVoff[2] + 8, 2, true
              );
              this.optVerBuffer[layer] = this.tilemapBuffer[2];
            }
            this.lastOrigTileX[layer] = lx >> 3;
          }
          if((this.optHorBuffer[layer] & andVal) > 0) {
            //origLx = lx;
            let add = ((tileStartX + 7) & 0x1f8);
            lx = (lx & 0x7) + ((this.optHorBuffer[layer] + add) & 0x1ff8);
          }
          if((this.optVerBuffer[layer] & andVal) > 0) {
            ly = (this.optVerBuffer[layer] & 0x1fff) + (ly - this.bgVoff[layer]);
          }
        }
        // if(logging && y === 32 && (this.mode === 2 || this.mode === 4 || this.mode === 6) && layer === 0) {
        //   log("at X = " + x + ", lx: " + getWordRep(lx) + ", ly: " + getWordRep(ly) + ", optHB: " + getWordRep(this.optHorBuffer[layer]) + ", orig lx: " + getWordRep(origLx));
        // }

        pixel = this.getPixelForLayer(
          lx, ly,
          layer,
          this.prioPerMode[modeIndex + j]
        );
      }
      if((pixel & 0xff) > 0) {
        break;
      }
    }
    layer = j === count ? 5 : layer;
    let color = this.cgram[pixel & 0xff];
    if(
      this.directColor && layer < 4 &&
      this.bitPerMode[this.mode * 4 + layer] === 8
    ) {
      let r = ((pixel & 0x7) << 2) | ((pixel & 0x100) >> 7);
      let g = ((pixel & 0x38) >> 1) | ((pixel & 0x200) >> 8);
      let b = ((pixel & 0xc0) >> 3) | ((pixel & 0x400) >> 8);
      color = (b << 10) | (g << 5) | r;
    }

    return [color, layer, pixel];
  }

  this.getMathEnabled = function(x, l, pal) {
    if(
      this.preventMath === 3 ||
      (this.preventMath === 2 && this.getWindowState(x, 5)) ||
      (this.preventMath === 1 && !this.getWindowState(x, 5))
    ) {
      return false;
    }
    if(this.mathEnabled[l] && (l !== 4 || pal >= 0xc0)) {
      return true;
    }
    return false;
  }

  this.getWindowState = function(x, l) {
    if(!this.window1Enabled[l] && !this.window2Enabled[l]) {
      return false;
    }
    if(this.window1Enabled[l] && !this.window2Enabled[l]) {
      let test = x >= this.window1Left && x <= this.window1Right;
      return this.window1Inversed[l] ? !test : test;
    }
    if(!this.window1Enabled[l] && this.window2Enabled[l]) {
      let test = x >= this.window2Left && x <= this.window2Right;
      return this.window2Inversed[l] ? !test : test;
    }
    // both window enabled
    let w1test = x >= this.window1Left && x <= this.window1Right;
    w1test = this.window1Inversed[l] ? !w1test : w1test;
    let w2test = x >= this.window2Left && x <= this.window2Right;
    w2test = this.window2Inversed[l] ? !w2test : w2test;
    switch(this.windowMaskLogic[l]) {
      case 0: {
        return w1test || w2test;
      }
      case 1: {
        return w1test && w2test;
      }
      case 2: {
        return w1test !== w2test;
      }
      case 3: {
        return w1test === w2test;
      }
    }
  }

  this.getPixelForLayer = function(x, y, l, p) {
    if(l > 3) {
      if(this.spritePrioBuffer[x] !== p) {
        return 0;
      }
      return this.spriteLineBuffer[x];
    }

    if(this.mode === 7) {
      return this.getMode7Pixel(x, y, l, p);
    }

    if(
      (x >> 3) !== this.lastTileFetchedX[l] ||
      y !== this.lastTileFetchedY[l]
    ) {
      this.fetchTileInBuffer(x, y, l, false);
      this.lastTileFetchedX[l] = (x >> 3);
      this.lastTileFetchedY[l] = y;
    }

    let mapWord = this.tilemapBuffer[l];
    if(((mapWord & 0x2000) >> 13) !== p) {
      // not the right priority
      return 0;
    }
    let paletteNum = (mapWord & 0x1c00) >> 10;
    let xShift = (mapWord & 0x4000) > 0 ? (x & 0x7) : 7 - (x & 0x7);

    paletteNum += this.mode === 0 ? l * 8 : 0;

    let bits = this.bitPerMode[this.mode * 4 + l];
    let mul = 4;
    let tileData = (this.tileBufferP1[l] >> xShift) & 0x1;
    tileData |= ((this.tileBufferP1[l] >> (8 + xShift)) & 0x1) << 1;

    if(bits > 2) {
      mul = 16;
      tileData |= ((this.tileBufferP2[l] >> xShift) & 0x1) << 2;
      tileData |= ((this.tileBufferP2[l] >> (8 + xShift)) & 0x1) << 3;
    }

    if(bits > 4) {
      mul = 256;
      tileData |= ((this.tileBufferP3[l] >> xShift) & 0x1) << 4;
      tileData |= ((this.tileBufferP3[l] >> (8 + xShift)) & 0x1) << 5;
      tileData |= ((this.tileBufferP4[l] >> xShift) & 0x1) << 6;
      tileData |= ((this.tileBufferP4[l] >> (8 + xShift)) & 0x1) << 7;
    }

    return tileData > 0 ? (paletteNum * mul + tileData) : 0;
  }

  this.fetchTileInBuffer = function(x, y, l, offset) {
    let rx = x;
    let ry = y;
    let useXbig = this.bigTiles[l] | this.mode === 5 | this.mode === 6;
    x >>= useXbig ? 1 : 0;
    y >>= this.bigTiles[l] ? 1 : 0;

    let adr = this.tilemapAdr[l] + (
      ((y & 0xff) >> 3) << 5 | ((x & 0xff) >> 3)
    );
    adr += ((x & 0x100) > 0 && this.tilemapWider[l]) ? 1024 : 0;
    adr += ((y & 0x100) > 0 && this.tilemapHigher[l]) ? (
      this.tilemapWider[l] ? 2048 : 1024
    ) : 0;
    this.tilemapBuffer[l] = this.vram[adr & 0x7fff];
    if(offset) {
      // for offset-per-tile, we only nees the tilemap byte,
      // don't fetch the tiles themselves
      return;
    }
    let yFlip = (this.tilemapBuffer[l] & 0x8000) > 0;
    let xFlip = (this.tilemapBuffer[l] & 0x4000) > 0;
    let yRow = yFlip ? 7 - (ry & 0x7) : (ry & 0x7);
    let tileNum = this.tilemapBuffer[l] & 0x3ff;

    tileNum += useXbig && (rx & 0x8) === (xFlip ? 0 : 8) ? 1 : 0;
    tileNum += this.bigTiles[l] && (ry & 0x8) === (yFlip ? 0 : 8) ? 0x10 : 0;

    let bits = this.bitPerMode[this.mode * 4 + l];

    this.tileBufferP1[l] = this.vram[
      (this.tileAdr[l] + tileNum * 4 * bits + yRow) & 0x7fff
    ];
    if(bits > 2) {
      this.tileBufferP2[l] = this.vram[
        (this.tileAdr[l] + tileNum * 4 * bits + yRow + 8) & 0x7fff
      ];
    }
    if(bits > 4) {
      this.tileBufferP3[l] = this.vram[
        (this.tileAdr[l] + tileNum * 4 * bits + yRow + 16) & 0x7fff
      ];
      this.tileBufferP4[l] = this.vram[
        (this.tileAdr[l] + tileNum * 4 * bits + yRow + 24) & 0x7fff
      ];
    }
  }

  this.evaluateSprites = function(line) {
    let spriteCount = 0;
    let sliverCount = 0;
    // search through oam, backwards
    // TODO: wrong (?): OAM is searched forwards for sprites in range,
    // and it's these in-range sprites that are handled backwards for tile fetching
    let index = this.objPriority ? ((this.oamAdr & 0xfe) - 2) & 0xff : 254;
    for(let i = 0; i < 128; i++) {
      let x = this.oam[index] & 0xff;
      let y = (this.oam[index] & 0xff00) >> 8;
      let tile = this.oam[index + 1] & 0xff;
      let ex = (this.oam[index + 1] & 0xff00) >> 8;
      x |= (this.highOam[index >> 4] >> (index & 0xf) & 0x1) << 8;
      let big = (this.highOam[index >> 4] >> (index & 0xf) & 0x2) > 0;
      x = x > 255 ? -(512 - x) : x;

      // check for being on this line
      let size = this.spriteSizes[this.objSize + (big ? 8 : 0)];
      let sprRow = line - y;
      if(sprRow < 0 || sprRow >= size * (this.objInterlace ? 4 : 8)) {
        // check if it is a sprite from the top of the screen
        sprRow = line + (256 - y);
      }
      if(
        sprRow >= 0 && sprRow < size * (this.objInterlace ? 4 : 8) &&
        x > -(size * 8)
      ) {
        // in range, show it
        if(spriteCount === 32) {
          // this would be the 33th sprite, exit the loop
          this.rangeOver = true;
          break;
        }
        sprRow = this.objInterlace ? sprRow * 2 + (
          this.evenFrame ? 1 : 0
        ) : sprRow;
        // fetch the tile(s)
        let adr = this.sprAdr1 + ((ex & 0x1) > 0 ? this.sprAdr2 : 0);
        sprRow = ((ex & 0x80) > 0) ? (size * 8) - 1 - sprRow : sprRow;
        let tileRow = sprRow >> 3;
        sprRow &= 0x7;
        for(let k = 0; k < size; k++) {
          if((x + k * 8) > -7 && (x + k * 8) < 256) {
            if(sliverCount === 34) {
              sliverCount = 35;
              break; // exit tile fetch loop, maximum slivers
            }
            let tileColumn = ((ex & 0x40) > 0) ? size - 1 - k : k;
            let tileNum = tile + this.spriteTileOffsets[
              tileRow * 8 + tileColumn
            ];
            tileNum &= 0xff;
            let tileP1 = this.vram[
              (adr + tileNum * 16 + sprRow) & 0x7fff
            ];
            let tileP2 = this.vram[
              (adr + tileNum * 16 + sprRow + 8) & 0x7fff
            ];
            // and draw it in the line buffer
            for(let j = 0; j < 8; j++) {
              let shift = ((ex & 0x40) > 0) ? j : 7 - j;
              let tileData = (tileP1 >> shift) & 0x1;
              tileData |= ((tileP1 >> (8 + shift)) & 0x1) << 1;
              tileData |= ((tileP2 >> shift) & 0x1) << 2;
              tileData |= ((tileP2 >> (8 + shift)) & 0x1) << 3;
              let color = tileData + 16 * ((ex & 0xe) >> 1);
              let xInd = x + k * 8 + j;
              if(tileData > 0 && xInd < 256 && xInd >= 0) {
                this.spriteLineBuffer[xInd] = 0x80 + color;
                this.spritePrioBuffer[xInd] = (ex & 0x30) >> 4;
              }
            }
            sliverCount++;
          }
        }
        if(sliverCount === 35) {
          // we exited the tile fetch loop because we reached max slivers
          // se we can stop evaluating sprites
          this.timeOver = true;
          break;
        }

        spriteCount++;
      }

      index = (index - 2) & 0xff;
    }
  }

  this.generateMode7Coords = function(y) {
    let rY = this.mode7FlipY ? 255 - y : y;

    let clippedH = this.mode7Hoff - this.mode7X;
    clippedH = (clippedH & 0x2000) > 0 ? (clippedH | ~0x3ff) : (clippedH & 0x3ff);
    let clippedV = this.mode7Voff - this.mode7Y;
    clippedV = (clippedV & 0x2000) > 0 ? (clippedV | ~0x3ff) : (clippedV & 0x3ff);

    let lineStartX = (
      ((this.mode7A * clippedH) & ~63) +
      ((this.mode7B * rY) & ~63) + ((this.mode7B * clippedV) & ~63) +
      (this.mode7X << 8)
    );
    let lineStartY = (
      ((this.mode7C * clippedH) & ~63) +
      ((this.mode7D * rY) & ~63) + ((this.mode7D * clippedV) & ~63) +
      (this.mode7Y << 8)
    );

    this.mode7Xcoords[0] = lineStartX;
    this.mode7Ycoords[0] = lineStartY;

    for(let i = 1; i < 256; i++) {
      this.mode7Xcoords[i] = this.mode7Xcoords[i - 1] + this.mode7A;
      this.mode7Ycoords[i] = this.mode7Ycoords[i - 1] + this.mode7C;
    }
  }

  this.getMode7Pixel = function(x, y, l, p) {
    let pixelData = this.tilemapBuffer[0];
    if(x !== this.lastTileFetchedX[0] || y !== this.lastTileFetchedY[0]) {
      let rX = this.mode7FlipX ? 255 - x : x;

      let px = this.mode7Xcoords[rX] >> 8;
      let py = this.mode7Ycoords[rX] >> 8;

      let pixelIsTransparent = false;

      if(this.mode7LargeField && (px < 0 || px >= 1024 || py < 0 || py >= 1024)) {
        if(this.mode7Char0fill) {
          // always use tile 0
          px &= 0x7;
          py &= 0x7;
        } else {
          // act as transparent
          pixelIsTransparent = true;
        }
      }
      // fetch the right tilemap byte
      let tileX = (px & 0x3f8) >> 3;
      let tileY = (py & 0x3f8) >> 3;

      let tileByte = this.vram[(tileY * 128 + tileX)] & 0xff;
      // fetch the tile
      pixelData = this.vram[tileByte * 64 + (py & 0x7) * 8 + (px & 0x7)];
      pixelData >>= 8;
      pixelData = pixelIsTransparent ? 0 : pixelData;
      this.tilemapBuffer[0] = pixelData;
      this.lastTileFetchedX[0] = x;
      this.lastTileFetchedY[0] = y;
    }

    if(l === 1 && (pixelData >> 7) !== p) {
      // wrong priority
      return 0;
    } else if(l === 1) {
      return pixelData & 0x7f;
    }

    return pixelData;
  }

  this.getVramRemap = function() {
    let adr = this.vramAdr & 0x7fff;
    if(this.vramRemap === 1) {
      adr = (adr & 0xff00) | ((adr & 0xe0) >> 5) | ((adr & 0x1f) << 3);
    } else if(this.vramRemap === 2) {
      adr = (adr & 0xfe00) | ((adr & 0x1c0) >> 6) | ((adr & 0x3f) << 3);
    } else if(this.vramRemap === 3) {
      adr = (adr & 0xfc00) | ((adr & 0x380) >> 7) | ((adr & 0x7f) << 3);
    }
    return adr;
  }

  this.get13Signed = function(val) {
    if((val & 0x1000) > 0) {
      return -(8192 - (val & 0xfff));
    }
    return (val & 0xfff);
  }

  this.get16Signed = function(val) {
    if((val & 0x8000) > 0) {
      return -(65536 - val);
    }
    return val;
  }

  this.getMultResult = function(a, b) {
    b = b < 0 ? 65536 + b : b;
    b >>= 8;
    b = ((b & 0x80) > 0) ? -(256 - b) : b;
    let ans = a * b;
    if(ans < 0) {
      return 16777216 + ans;
    }
    return ans;
  }

  this.read = function(adr) {
    switch(adr) {
      case 0x34: {
        return this.multResult & 0xff;
      }
      case 0x35: {
        return (this.multResult & 0xff00) >> 8;
      }
      case 0x36: {
        return (this.multResult & 0xff0000) >> 16;
      }
      case 0x37: {
        if(this.snes.ppuLatch) {
          this.latchedHpos = this.snes.xPos >> 2;
          this.latchedVpos = this.snes.yPos;
          this.countersLatched = true;
        }
        return this.snes.openBus;
      }
      case 0x38: {
        let val;
        if(!this.oamSecond) {
          if(this.oamInHigh) {
            val = this.highOam[this.oamAdr & 0xf] & 0xff;
          } else {
            val = this.oam[this.oamAdr] & 0xff;
          }
          this.oamSecond = true;
        } else {
          if(this.oamInHigh) {
            val = this.highOam[this.oamAdr & 0xf] >> 8;
          } else {
            val = this.oam[this.oamAdr] >> 8;
          }
          this.oamAdr++;
          this.oamAdr &= 0xff;
          this.oamInHigh = (
            this.oamAdr === 0
          ) ? !this.oamInHigh : this.oamInHigh;
          this.oamSecond = false;
        }
        return val;
      }
      case 0x39: {
        let val = this.vramReadBuffer;
        if(!this.vramIncOnHigh) {
          this.vramReadBuffer = this.vram[this.getVramRemap()];
          this.vramAdr += this.vramInc;
          this.vramAdr &= 0xffff;
        }
        return val & 0xff;
      }
      case 0x3a: {
        let val = this.vramReadBuffer;
        if(this.vramIncOnHigh) {
          this.vramReadBuffer = this.vram[this.getVramRemap()];
          this.vramAdr += this.vramInc;
          this.vramAdr &= 0xffff;
        }
        return (val & 0xff00) >> 8;
      }
      case 0x3b: {
        let val;
        if(!this.cgramSecond) {
          val = this.cgram[this.cgramAdr] & 0xff;
          this.cgramSecond = true;
        } else {
          val = this.cgram[this.cgramAdr++] >> 8;
          this.cgramAdr &= 0xff;
          this.cgramSecond = false;
        }
        return val;
      }
      case 0x3c: {
        let val;
        if(!this.latchHsecond) {
          val = this.latchedHpos & 0xff;
          this.latchHsecond = true;
        } else {
          val = (this.latchedHpos & 0xff00) >> 8;
          this.latchHsecond = false;
        }
        return val;
      }
      case 0x3d: {
        let val;
        if(!this.latchVsecond) {
          val = this.latchedVpos & 0xff;
          this.latchVsecond = true;
        } else {
          val = (this.latchedVpos & 0xff00) >> 8;
          this.latchVsecond = false;
        }
        return val;
      }
      case 0x3e: {
        let val = this.timeOver ? 0x80 : 0;
        val |= this.rangeOver ? 0x40 : 0;
        return val | 0x1;
      }
      case 0x3f: {
        let val = this.evenFrame ? 0x80 : 0;
        val |= this.countersLatched ? 0x40 : 0;
        if(this.snes.ppuLatch) {
          this.countersLatched = false;
        }
        this.latchHsecond = false;
        this.latchVsecond = false;
        return val | 0x3;
      }
    }
    return this.snes.openBus;
  }

  this.write = function(adr, value) {
    switch(adr) {
      case 0x00: {
        this.forcedBlank = (value & 0x80) > 0;
        this.brightness = value & 0xf;
        return;
      }
      case 0x01: {
        this.sprAdr1 = (value & 0x7) << 13;
        this.sprAdr2 = ((value & 0x18) + 8) << 9;
        this.objSize = (value & 0xe0) >> 5;
        return;
      }
      case 0x02: {
        this.oamAdr = value;
        this.oamRegAdr = this.oamAdr;
        this.oamInHigh = this.oamRegInHigh;
        this.oamSecond = false;
        return;
      }
      case 0x03: {
        this.oamInHigh = (value & 0x1) > 0;
        this.objPriority = (value & 0x80) > 0;
        this.oamAdr = this.oamRegAdr;
        this.oamRegInHigh = this.oamInHigh
        this.oamSecond = false;
        return;
      }
      case 0x04: {
        if(!this.oamSecond) {
          if(this.oamInHigh) {
            this.highOam[
              this.oamAdr & 0xf
            ] = (this.highOam[this.oamAdr & 0xf] & 0xff00) | value;
          } else {
            this.oamBuffer = (this.oamBuffer & 0xff00) | value;
          }
          this.oamSecond = true;
        } else {
          if(this.oamInHigh) {
            this.highOam[
              this.oamAdr & 0xf
            ] = (this.highOam[this.oamAdr & 0xf] & 0xff) | (value << 8);
          } else {
            this.oamBuffer = (this.oamBuffer & 0xff) | (value << 8);
            this.oam[this.oamAdr] = this.oamBuffer;
          }
          this.oamAdr++;
          this.oamAdr &= 0xff;
          this.oamInHigh = (
            this.oamAdr === 0
          ) ? !this.oamInHigh : this.oamInHigh;
          this.oamSecond = false;
        }
        return;
      }
      case 0x05: {
        this.mode = value & 0x7;
        this.layer3Prio = (value & 0x08) > 0;
        this.bigTiles[0] = (value & 0x10) > 0;
        this.bigTiles[1] = (value & 0x20) > 0;
        this.bigTiles[2] = (value & 0x40) > 0;
        this.bigTiles[3] = (value & 0x80) > 0;
        return;
      }
      case 0x06: {
        this.mosaicEnabled[0] = (value & 0x1) > 0;
        this.mosaicEnabled[1] = (value & 0x2) > 0;
        this.mosaicEnabled[2] = (value & 0x4) > 0;
        this.mosaicEnabled[3] = (value & 0x8) > 0;
        this.mosaicSize = ((value & 0xf0) >> 4) + 1;
        this.mosaicStartLine = this.snes.yPos;
        return;
      }
      case 0x07:
      case 0x08:
      case 0x09:
      case 0x0a: {
        this.tilemapWider[adr - 7] = (value & 0x1) > 0;
        this.tilemapHigher[adr - 7] = (value & 0x2) > 0;
        this.tilemapAdr[adr - 7] = (value & 0xfc) << 8;
        return;
      }
      case 0x0b: {
        this.tileAdr[0] = (value & 0xf) << 12;
        this.tileAdr[1] = (value & 0xf0) << 8;
        return;
      }
      case 0x0c: {
        this.tileAdr[2] = (value & 0xf) << 12;
        this.tileAdr[3] = (value & 0xf0) << 8;
        return;
      }
      case 0x0d: {
        this.mode7Hoff = this.get13Signed((value << 8) | this.mode7Prev);
        this.mode7Prev = value;
        // fall through to also set normal layer bgHoff
      }
      case 0x0f:
      case 0x11:
      case 0x13: {
        this.bgHoff[
          (adr - 0xd) >> 1
        ] = (value << 8) | (this.offPrev1 & 0xf8) | (this.offPrev2 & 0x7);
        this.offPrev1 = value;
        this.offPrev2 = value;
        return;
      }
      case 0x0e: {
        this.mode7Voff = this.get13Signed((value << 8) | this.mode7Prev);
        this.mode7Prev = value;
        // fall through to also set normal layer bgVoff
      }
      case 0x10:
      case 0x12:
      case 0x14: {
        this.bgVoff[
          (adr - 0xe) >> 1
        ] = (value << 8) | (this.offPrev1 & 0xff);
        this.offPrev1 = value;
        return;
      }
      case 0x15: {
        let incVal = value & 0x3;
        if(incVal === 0) {
          this.vramInc = 1;
        } else if(incVal === 1) {
          this.vramInc = 32;
        } else {
          this.vramInc = 128;
        }
        this.vramRemap = (value & 0x0c) >> 2;
        this.vramIncOnHigh = (value & 0x80) > 0;
        return;
      }
      case 0x16: {
        this.vramAdr = (this.vramAdr & 0xff00) | value;
        this.vramReadBuffer = this.vram[this.getVramRemap()];
        return;
      }
      case 0x17: {
        this.vramAdr = (this.vramAdr & 0xff) | (value << 8);
        this.vramReadBuffer = this.vram[this.getVramRemap()];
        return;
      }
      case 0x18: {
        let adr = this.getVramRemap();
        // TODO: VRAM access during non-vblank and non-forced blank should be blocked,
        // but that makes Super Metroid unable to properly update tiles on screen
        // if(this.forcedBlank || this.snes.ypos > (this.frameOverscan ? 239 : 224)) {
          this.vram[adr] = (this.vram[adr] & 0xff00) | value;
        // }
        if(!this.vramIncOnHigh) {
          this.vramAdr += this.vramInc;
          this.vramAdr &= 0xffff;
        }
        return;
      }
      case 0x19: {
        let adr = this.getVramRemap();
        // if(this.forcedBlank || this.snes.ypos > (this.frameOverscan ? 239 : 224)) {
          this.vram[adr] = (this.vram[adr] & 0xff) | (value << 8);
        // }
        if(this.vramIncOnHigh) {
          this.vramAdr += this.vramInc;
          this.vramAdr &= 0xffff;
        }
        return;
      }
      case 0x1a: {
        this.mode7LargeField = (value & 0x80) > 0;
        this.mode7Char0fill = (value & 0x40) > 0;
        this.mode7FlipY = (value & 0x2) > 0;
        this.mode7FlipX = (value & 0x1) > 0;
        return;
      }
      case 0x1b: {
        this.mode7A = this.get16Signed((value << 8) | this.mode7Prev);
        this.mode7Prev = value;
        this.multResult = this.getMultResult(this.mode7A, this.mode7B);
        return;
      }
      case 0x1c: {
        this.mode7B = this.get16Signed((value << 8) | this.mode7Prev);
        this.mode7Prev = value;
        this.multResult = this.getMultResult(this.mode7A, this.mode7B);
        return;
      }
      case 0x1d: {
        this.mode7C = this.get16Signed((value << 8) | this.mode7Prev);
        this.mode7Prev = value;
        return;
      }
      case 0x1e: {
        this.mode7D = this.get16Signed((value << 8) | this.mode7Prev);
        this.mode7Prev = value;
        return;
      }
      case 0x1f: {
        this.mode7X = this.get13Signed((value << 8) | this.mode7Prev);
        this.mode7Prev = value;
        return;
      }
      case 0x20: {
        this.mode7Y = this.get13Signed((value << 8) | this.mode7Prev);
        this.mode7Prev = value;
        return;
      }
      case 0x21: {
        this.cgramAdr = value;
        this.cgramSecond = false;
        return;
      }
      case 0x22: {
        if(!this.cgramSecond) {
          this.cgramBuffer = (this.cgramBuffer & 0xff00) | value;
          this.cgramSecond = true;
        } else {
          this.cgramBuffer = (this.cgramBuffer & 0xff) | (value << 8);
          this.cgram[this.cgramAdr++] = this.cgramBuffer;
          this.cgramAdr &= 0xff;
          this.cgramSecond = false;
        }
        return;
      }
      case 0x23: {
        this.window1Inversed[0] = (value & 0x01) > 0;
        this.window1Enabled[0] = (value & 0x02) > 0;
        this.window2Inversed[0] = (value & 0x04) > 0;
        this.window2Enabled[0] = (value & 0x08) > 0;
        this.window1Inversed[1] = (value & 0x10) > 0;
        this.window1Enabled[1] = (value & 0x20) > 0;
        this.window2Inversed[1] = (value & 0x40) > 0;
        this.window2Enabled[1] = (value & 0x80) > 0;
        return;
      }
      case 0x24: {
        this.window1Inversed[2] = (value & 0x01) > 0;
        this.window1Enabled[2] = (value & 0x02) > 0;
        this.window2Inversed[2] = (value & 0x04) > 0;
        this.window2Enabled[2] = (value & 0x08) > 0;
        this.window1Inversed[3] = (value & 0x10) > 0;
        this.window1Enabled[3] = (value & 0x20) > 0;
        this.window2Inversed[3] = (value & 0x40) > 0;
        this.window2Enabled[3] = (value & 0x80) > 0;
        return;
      }
      case 0x25: {
        this.window1Inversed[4] = (value & 0x01) > 0;
        this.window1Enabled[4] = (value & 0x02) > 0;
        this.window2Inversed[4] = (value & 0x04) > 0;
        this.window2Enabled[4] = (value & 0x08) > 0;
        this.window1Inversed[5] = (value & 0x10) > 0;
        this.window1Enabled[5] = (value & 0x20) > 0;
        this.window2Inversed[5] = (value & 0x40) > 0;
        this.window2Enabled[5] = (value & 0x80) > 0;
        return;
      }
      case 0x26: {
        this.window1Left = value;
        return;
      }
      case 0x27: {
        this.window1Right = value;
        return;
      }
      case 0x28: {
        this.window2Left = value;
        return;
      }
      case 0x29: {
        this.window2Right = value;
        return;
      }
      case 0x2a: {
        this.windowMaskLogic[0] = value & 0x3;
        this.windowMaskLogic[1] = (value & 0xc) >> 2;
        this.windowMaskLogic[2] = (value & 0x30) >> 4;
        this.windowMaskLogic[3] = (value & 0xc0) >> 6;
        return;
      }
      case 0x2b: {
        this.windowMaskLogic[4] = value & 0x3;
        this.windowMaskLogic[5] = (value & 0xc) >> 2;
        return;
      }
      case 0x2c: {
        this.mainScreenEnabled[0] = (value & 0x1) > 0;
        this.mainScreenEnabled[1] = (value & 0x2) > 0;
        this.mainScreenEnabled[2] = (value & 0x4) > 0;
        this.mainScreenEnabled[3] = (value & 0x8) > 0;
        this.mainScreenEnabled[4] = (value & 0x10) > 0;
        return;
      }
      case 0x2d: {
        this.subScreenEnabled[0] = (value & 0x1) > 0;
        this.subScreenEnabled[1] = (value & 0x2) > 0;
        this.subScreenEnabled[2] = (value & 0x4) > 0;
        this.subScreenEnabled[3] = (value & 0x8) > 0;
        this.subScreenEnabled[4] = (value & 0x10) > 0;
        return;
      }
      case 0x2e: {
        this.mainScreenWindow[0] = (value & 0x1) > 0;
        this.mainScreenWindow[1] = (value & 0x2) > 0;
        this.mainScreenWindow[2] = (value & 0x4) > 0;
        this.mainScreenWindow[3] = (value & 0x8) > 0;
        this.mainScreenWindow[4] = (value & 0x10) > 0;
        return;
      }
      case 0x2f: {
        this.subScreenWindow[0] = (value & 0x1) > 0;
        this.subScreenWindow[1] = (value & 0x2) > 0;
        this.subScreenWindow[2] = (value & 0x4) > 0;
        this.subScreenWindow[3] = (value & 0x8) > 0;
        this.subScreenWindow[4] = (value & 0x10) > 0;
        return;
      }
      case 0x30: {
        this.colorClip = (value & 0xc0) >> 6;
        this.preventMath = (value & 0x30) >> 4;
        this.addSub = (value & 0x2) > 0;
        this.directColor = (value & 0x1) > 0;
        return;
      }
      case 0x31: {
        this.subtractColors = (value & 0x80) > 0;
        this.halfColors = (value & 0x40) > 0;
        this.mathEnabled[0] = (value & 0x1) > 0;
        this.mathEnabled[1] = (value & 0x2) > 0;
        this.mathEnabled[2] = (value & 0x4) > 0;
        this.mathEnabled[3] = (value & 0x8) > 0;
        this.mathEnabled[4] = (value & 0x10) > 0;
        this.mathEnabled[5] = (value & 0x20) > 0;
        return;
      }
      case 0x32: {
        if((value & 0x80) > 0) {
          this.fixedColorB = value & 0x1f;
        }
        if((value & 0x40) > 0) {
          this.fixedColorG = value & 0x1f;
        }
        if((value & 0x20) > 0) {
          this.fixedColorR = value & 0x1f;
        }
        return;
      }
      case 0x33: {
        this.mode7ExBg = (value & 0x40) > 0;
        this.pseudoHires = (value & 0x08) > 0;
        this.overscan = (value & 0x04) > 0;
        this.objInterlace = (value & 0x02) > 0;
        this.interlace = (value & 0x01) > 0;
        return;
      }
    }
  }

  this.setPixels = function(arr) {

    if(!this.frameOverscan) {
      // clear the top 8 and bottom 8 lines to transarent
      for(let i = 0; i < 512*16; i++) {
        let x = i % 512;
        let y = (i >> 9);
        let ind = (y * 512 + x) * 4;
        arr[ind + 3] = 0;
      }
      for(let i = 0; i < 512*16; i++) {
        let x = i % 512;
        let y = (i >> 9);
        let ind = ((y + 464) * 512 + x) * 4;
        arr[ind + 3] = 0;
      }
    }

    let addY = this.frameOverscan ? 0 : 14;

    for(let i = 512; i < 512 * (this.frameOverscan ? 240 : 225); i++) {
      let x = i % 512;
      let y = (i >> 9) * 2;
      let ind = ((y + addY) * 512 + x) * 4;
      let r = this.pixelOutput[i * 3];
      let g = this.pixelOutput[i * 3 + 1];
      let b = this.pixelOutput[i * 3 + 2];
      if(!this.frameInterlace || this.evenFrame) {
        arr[ind] = r;
        arr[ind + 1] = g;
        arr[ind + 2] = b;
        arr[ind + 3] = 255;
      }
      ind += 512 * 4;
      if(!this.frameInterlace || !this.evenFrame) {
        arr[ind] = r;
        arr[ind + 1] = g;
        arr[ind + 2] = b;
        arr[ind + 3] = 255;
      }
    }
  }

}

var Cpu = (function() {
  // indexes in register arrays
  const DBR = 0; // data bank register
  const K = 1; // program bank

  const A = 0;
  const X = 1;
  const Y = 2;
  const SP = 3;
  const PC = 4;
  const DPR = 5; // direct page register

  // addressing modes
  const IMP = 0; // or ACC
  const IMM = 1; // always 8 bit
  const IMMm = 2; // size depends on m flag
  const IMMx = 3; // size depends on x flag
  const IMMl = 4; // always 16 bit
  const DP = 5;
  const DPX = 6;
  const DPY = 7;
  const IDP = 8
  const IDX = 9;
  const IDY = 10; // for RMW and writes
  const IDYr = 11; // for reads
  const IDL = 12;
  const ILY = 13;
  const SR = 14;
  const ISY = 15;
  const ABS = 16;
  const ABX = 17; // for RMW and writes
  const ABXr = 18; // for reads
  const ABY = 19; // for RMW and writes
  const ABYr = 20; // for reads
  const ABL = 21;
  const ALX = 22;
  const IND = 23;
  const IAX = 24;
  const IAL = 25;
  const REL = 26;
  const RLL = 27;
  const BM = 28; // block move

  return function(mem) {

    // memory handler
    this.mem = mem;

    // registers
    this.r = new Uint8Array(2);
    this.br = new Uint16Array(6);

    // modes for each instruction
    this.modes = [
      IMP, IDX, IMM, SR , DP , DP , DP , IDL, IMP, IMMm,IMP, IMP, ABS, ABS, ABS, ABL,
      REL, IDYr,IDP, ISY, DP , DPX, DPX, ILY, IMP, ABYr,IMP, IMP, ABS, ABXr,ABX, ALX,
      ABS, IDX, ABL, SR , DP , DP , DP , IDL, IMP, IMMm,IMP, IMP, ABS, ABS, ABS, ABL,
      REL, IDYr,IDP, ISY, DPX, DPX, DPX, ILY, IMP, ABYr,IMP, IMP, ABXr,ABXr,ABX, ALX,
      IMP, IDX, IMM, SR , BM , DP , DP , IDL, IMP, IMMm,IMP, IMP, ABS, ABS, ABS, ABL,
      REL, IDYr,IDP, ISY, BM , DPX, DPX, ILY, IMP, ABYr,IMP, IMP, ABL, ABXr,ABX, ALX,
      IMP, IDX, RLL, SR , DP , DP , DP , IDL, IMP, IMMm,IMP, IMP, IND, ABS, ABS, ABL,
      REL, IDYr,IDP, ISY, DPX, DPX, DPX, ILY, IMP, ABYr,IMP, IMP, IAX, ABXr,ABX, ALX,
      REL, IDX, RLL, SR , DP , DP , DP , IDL, IMP, IMMm,IMP, IMP, ABS, ABS, ABS, ABL,
      REL, IDY, IDP, ISY, DPX, DPX, DPY, ILY, IMP, ABY, IMP, IMP, ABS, ABX, ABX, ALX,
      IMMx,IDX, IMMx,SR , DP , DP , DP , IDL, IMP, IMMm,IMP, IMP, ABS, ABS, ABS, ABL,
      REL, IDYr,IDP, ISY, DPX, DPX, DPY, ILY, IMP, ABYr,IMP, IMP, ABXr,ABXr,ABYr,ALX,
      IMMx,IDX, IMM, SR , DP , DP , DP , IDL, IMP, IMMm,IMP, IMP, ABS, ABS, ABS, ABL,
      REL, IDYr,IDP, ISY, DP , DPX, DPX, ILY, IMP, ABYr,IMP, IMP, IAL, ABXr,ABX, ALX,
      IMMx,IDX, IMM, SR , DP , DP , DP , IDL, IMP, IMMm,IMP, IMP, ABS, ABS, ABS, ABL,
      REL, IDYr,IDP, ISY, IMMl,DPX, DPX, ILY, IMP, ABYr,IMP, IMP, IAX, ABXr,ABX, ALX,
      IMP, IMP, IMP // abo, nmi, irq
    ];

    // cycles for each instruction
    this.cycles = [
      7, 6, 7, 4, 5, 3, 5, 6, 3, 2, 2, 4, 6, 4, 6, 5,
      2, 5, 5, 7, 5, 4, 6, 6, 2, 4, 2, 2, 6, 4, 7, 5,
      6, 6, 8, 4, 3, 3, 5, 6, 4, 2, 2, 5, 4, 4, 6, 5,
      2, 5, 5, 7, 4, 4, 6, 6, 2, 4, 2, 2, 4, 4, 7, 5,
      6, 6, 2, 4, 7, 3, 5, 6, 3, 2, 2, 3, 3, 4, 6, 5,
      2, 5, 5, 7, 7, 4, 6, 6, 2, 4, 3, 2, 4, 4, 7, 5,
      6, 6, 6, 4, 3, 3, 5, 6, 4, 2, 2, 6, 5, 4, 6, 5,
      2, 5, 5, 7, 4, 4, 6, 6, 2, 4, 4, 2, 6, 4, 7, 5,
      3, 6, 4, 4, 3, 3, 3, 6, 2, 2, 2, 3, 4, 4, 4, 5,
      2, 6, 5, 7, 4, 4, 4, 6, 2, 5, 2, 2, 4, 5, 5, 5,
      2, 6, 2, 4, 3, 3, 3, 6, 2, 2, 2, 4, 4, 4, 4, 5,
      2, 5, 5, 7, 4, 4, 4, 6, 2, 4, 2, 2, 4, 4, 4, 5,
      2, 6, 3, 4, 3, 3, 5, 6, 2, 2, 2, 3, 4, 4, 6, 5,
      2, 5, 5, 7, 6, 4, 6, 6, 2, 4, 3, 3, 6, 4, 7, 5,
      2, 6, 3, 4, 3, 3, 5, 6, 2, 2, 2, 3, 4, 4, 6, 5,
      2, 5, 5, 7, 5, 4, 6, 6, 2, 4, 4, 2, 8, 4, 7, 5,
      7, 7, 7 // abo, nmi, irq
    ];

    // function table is at bottom

    this.reset = function() {

      this.r[DBR] = 0;
      this.r[K] = 0;

      this.br[A] = 0;
      this.br[X] = 0;
      this.br[Y] = 0;
      this.br[SP] = 0;
      this.br[DPR] = 0;

      if(this.mem.read) {
        // read emulation mode reset vector
        this.br[PC] = this.mem.read(0xfffc) | (this.mem.read(0xfffd) << 8);
      } else {
        // if read function is not defined yet
        this.br[PC] = 0;
      }

      // flags
      this.n = false;
      this.v = false;
      this.m = true;
      this.x = true;
      this.d = false;
      this.i = false;
      this.z = false;
      this.c = false;
      this.e = true;

      // interrupts wanted
      this.irqWanted = false;
      this.nmiWanted = false;
      this.aboWanted = false;

      // power state
      this.stopped = false;
      this.waiting = false;

      // cycles left
      this.cyclesLeft = 7;

    }
    this.reset();

    this.cycle = function() {
      if(this.cyclesLeft === 0) {
        if(this.stopped) {
          // stopped
          this.cyclesLeft = 1;
        } else if(!this.waiting) {
          // read opcode byte
          let instr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          this.cyclesLeft = this.cycles[instr];
          let mode = this.modes[instr];
          // test for interrupt
          if((this.irqWanted && !this.i) || this.nmiWanted || this.aboWanted) {
            this.br[PC]--;
            if(this.aboWanted) {
              this.aboWanted = false;
              instr = 0x100;
            } else if(this.nmiWanted) {
              this.nmiWanted = false;
              instr = 0x101;
            } else {
              // irq (level sensitive instead of edge sensitive)
              instr = 0x102;
            }
            this.cyclesLeft = this.cycles[instr];
            mode = this.modes[instr];
          }
          // execute the instruction
          let adrs = this.getAdr(instr, mode);
          // TEMP: log unknown instruction
          if(this.functions[instr] === undefined) {
            this.uni(adrs[0], adrs[1], instr);
          } else {
            this.functions[instr].call(this, adrs[0], adrs[1]);
          }
        } else {
          // waiting on interrupt
          if(this.abortWanted || this.irqWanted || this.nmiWanted) {
            this.waiting = false;
            // on next cycle, find the nmi or abort and start executing it,
            // or continue on as a fast irq if i is 1
          }
          this.cyclesLeft = 1;
        }
      }
      this.cyclesLeft--;
    }

    this.getP = function() {
      let val = 0;
      val |= this.n ? 0x80 : 0;
      val |= this.v ? 0x40 : 0;
      val |= this.m ? 0x20 : 0;
      val |= this.x ? 0x10 : 0;
      val |= this.d ? 0x08 : 0;
      val |= this.i ? 0x04 : 0;
      val |= this.z ? 0x02 : 0;
      val |= this.c ? 0x01 : 0;
      return val;
    }

    this.setP = function(value) {
      this.n = (value & 0x80) > 0;
      this.v = (value & 0x40) > 0;
      this.m = (value & 0x20) > 0;
      this.x = (value & 0x10) > 0;
      this.d = (value & 0x08) > 0;
      this.i = (value & 0x04) > 0;
      this.z = (value & 0x02) > 0;
      this.c = (value & 0x01) > 0;
      if(this.x) {
        this.br[X] &= 0xff;
        this.br[Y] &= 0xff;
      }
    }

    this.setZandN = function(value, byte) {
      // sets Zero and Negative depending on 8-bit or 16-bit value
      if(byte) {
        this.z = (value & 0xff) === 0;
        this.n = (value & 0x80) > 0;
        return;
      }
      this.z = (value & 0xffff) === 0;
      this.n = (value & 0x8000) > 0;
    }

    this.getSigned = function(value, byte) {
      // turns unsinged value 0 - 255 or 0 - 65536
      // to signed -128 - 127 or -32768 - 32767
      if(byte) {
        return (value & 0xff) > 127 ? -(256 - (value & 0xff)) : (value & 0xff);
      }
      return value > 32767 ? -(65536 - value) : value;
    }

    this.doBranch = function(check, rel) {
      if(check) {
        // taken branch: 1 extra cycle
        this.cyclesLeft++;
        this.br[PC] += rel;
      }
    }

    this.pushByte = function(value) {
      if(this.e) {
        this.mem.write((this.br[SP] & 0xff) | 0x100, value);
      } else {
        this.mem.write(this.br[SP], value);
      }
      this.br[SP]--;
    }

    this.pullByte = function() {
      this.br[SP]++;
      if(this.e) {
        return this.mem.read((this.br[SP] & 0xff) | 0x100);
      }
      return this.mem.read(this.br[SP]);
    }

    this.pushWord = function(value) {
      this.pushByte((value & 0xff00) >> 8);
      this.pushByte(value & 0xff);
    }

    this.pullWord = function() {
      let value = this.pullByte();
      value |= this.pullByte() << 8;
      return value;
    }

    this.readWord = function(adr, adrh) {
      let value = this.mem.read(adr);
      value |= this.mem.read(adrh) << 8;
      return value;
    }

    this.writeWord = function(adr, adrh, result, reversed = false) {
      if(reversed) {
        // RMW opcodes write the high byte first
        this.mem.write(adrh, (result & 0xff00) >> 8);
        this.mem.write(adr, result & 0xff);
      } else {
        this.mem.write(adr, result & 0xff);
        this.mem.write(adrh, (result & 0xff00) >> 8);
      }
    }

    this.getAdr = function(opcode, mode) {
      // gets the effective address (low and high), for the given adressing mode
      switch(mode) {
        case IMP: {
          // implied
          return [0, 0];
        }

        case IMM: {
          // immediate, always 8 bit
          return [(this.r[K] << 16) | this.br[PC]++, 0];
        }

        case IMMm: {
          // immediate, depending on m
          if(this.m) {
            return [(this.r[K] << 16) | this.br[PC]++, 0];
          } else {
            let low = (this.r[K] << 16) | this.br[PC]++;
            return [low, (this.r[K] << 16) | this.br[PC]++];
          }
        }

        case IMMx: {
          // immediate, depending on x
          if(this.x) {
            return [(this.r[K] << 16) | this.br[PC]++, 0];
          } else {
            let low = (this.r[K] << 16) | this.br[PC]++;
            return [low, (this.r[K] << 16) | this.br[PC]++];
          }
        }

        case IMMl: {
          // immediate, always 16 bit
          let low = (this.r[K] << 16) | this.br[PC]++;
          return [low, (this.r[K] << 16) | this.br[PC]++];
        }

        case DP: {
          // direct page
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          if((this.br[DPR] & 0xff) !== 0) {
            // DPRl not 0: 1 extra cycle
            this.cyclesLeft++;
          }
          return [
            (this.br[DPR] + adr) & 0xffff,
            (this.br[DPR] + adr + 1) & 0xffff
          ];
        }

        case DPX: {
          // direct page indexed on X
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          if((this.br[DPR] & 0xff) !== 0) {
            // DPRl not 0: 1 extra cycle
            this.cyclesLeft++;
          }
          return [
            (this.br[DPR] + adr + this.br[X]) & 0xffff,
            (this.br[DPR] + adr + this.br[X] + 1) & 0xffff
          ];
        }

        case DPY: {
          // direct page indexed on Y
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          if((this.br[DPR] & 0xff) !== 0) {
            // DPRl not 0: 1 extra cycle
            this.cyclesLeft++;
          }
          return [
            (this.br[DPR] + adr + this.br[Y]) & 0xffff,
            (this.br[DPR] + adr + this.br[Y] + 1) & 0xffff
          ];
        }

        case IDP: {
          // direct indirect
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          if((this.br[DPR] & 0xff) !== 0) {
            // DPRl not 0: 1 extra cycle
            this.cyclesLeft++;
          }
          let pointer = this.mem.read((this.br[DPR] + adr) & 0xffff);
          pointer |= (
            this.mem.read((this.br[DPR] + adr + 1) & 0xffff)
          ) << 8;
          return [
            (this.r[DBR] << 16) + pointer,
            (this.r[DBR] << 16) + pointer + 1
          ];
        }

        case IDX: {
          // direct indirect indexed
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          if((this.br[DPR] & 0xff) !== 0) {
            // DPRl not 0: 1 extra cycle
            this.cyclesLeft++;
          }
          let pointer = this.mem.read(
            (this.br[DPR] + adr + this.br[X]) & 0xffff
          );
          pointer |= (
            this.mem.read((this.br[DPR] + adr + this.br[X] + 1) & 0xffff)
          ) << 8;
          return [
            (this.r[DBR] << 16) + pointer,
            (this.r[DBR] << 16) + pointer + 1
          ];
        }

        case IDY: {
          // indirect direct indexed, for RMW and writes
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          if((this.br[DPR] & 0xff) !== 0) {
            // DPRl not 0: 1 extra cycle
            this.cyclesLeft++;
          }
          let pointer = this.mem.read((this.br[DPR] + adr) & 0xffff);
          pointer |= (
            this.mem.read((this.br[DPR] + adr + 1) & 0xffff)
          ) << 8;
          return [
            (this.r[DBR] << 16) + pointer + this.br[Y],
            (this.r[DBR] << 16) + pointer + this.br[Y] + 1
          ];
        }

        case IDYr: {
          // indirect direct indexed, for reads (possible extra cycle)
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          if((this.br[DPR] & 0xff) !== 0) {
            // DPRl not 0: 1 extra cycle
            this.cyclesLeft++;
          }
          let pointer = this.mem.read((this.br[DPR] + adr) & 0xffff);
          pointer |= (
            this.mem.read((this.br[DPR] + adr + 1) & 0xffff)
          ) << 8;
          if(((pointer >> 8) !== ((pointer + this.br[Y]) >> 8)) || !this.x) {
            // if page is crossed, or x is 0: 1 extra cycle
            this.cyclesLeft++;
          }
          return [
            (this.r[DBR] << 16) + pointer + this.br[Y],
            (this.r[DBR] << 16) + pointer + this.br[Y] + 1
          ];
        }

        case IDL: {
          // indirect direct long
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          if((this.br[DPR] & 0xff) !== 0) {
            // DPRl not 0: 1 extra cycle
            this.cyclesLeft++;
          }
          let pointer = this.mem.read((this.br[DPR] + adr) & 0xffff);
          pointer |= (
            this.mem.read((this.br[DPR] + adr + 1) & 0xffff)
          ) << 8;
          pointer |= (
            this.mem.read((this.br[DPR] + adr + 2) & 0xffff)
          ) << 16;
          return [pointer, pointer + 1];
        }

        case ILY: {
          // indirect direct long indexed
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          if((this.br[DPR] & 0xff) !== 0) {
            // DPRl not 0: 1 extra cycle
            this.cyclesLeft++;
          }
          let pointer = this.mem.read((this.br[DPR] + adr) & 0xffff);
          pointer |= (
            this.mem.read((this.br[DPR] + adr + 1) & 0xffff)
          ) << 8;
          pointer |= (
            this.mem.read((this.br[DPR] + adr + 2) & 0xffff)
          ) << 16;
          return [pointer + this.br[Y], pointer + this.br[Y] + 1];
        }

        case SR: {
          // stack relative
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          return [
            (this.br[SP] + adr) & 0xffff,
            (this.br[SP] + adr + 1) & 0xffff,
          ];
        }

        case ISY: {
          // stack relative indexed
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          let pointer = this.mem.read((this.br[SP] + adr) & 0xffff);
          pointer |= (
            this.mem.read((this.br[SP] + adr + 1) & 0xffff)
          ) << 8;
          return [
            (this.r[DBR] << 16) + pointer + this.br[Y],
            (this.r[DBR] << 16) + pointer + this.br[Y] + 1,
          ];
        }

        case ABS: {
          // absolute
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          return [(this.r[DBR] << 16) + adr, (this.r[DBR] << 16) + adr + 1];
        }

        case ABX: {
          // absolute, indexed by X for RMW and writes
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          return [
            (this.r[DBR] << 16) + adr + this.br[X],
            (this.r[DBR] << 16) + adr + this.br[X] + 1
          ];
        }

        case ABXr: {
          // absolute, indexed by X for reads (possible extra cycle)
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          if(((adr >> 8) !== ((adr + this.br[X]) >> 8)) || !this.x) {
            // if page crossed or x is 0: 1 extra cycle
            this.cyclesLeft++;
          }
          return [
            (this.r[DBR] << 16) + adr + this.br[X],
            (this.r[DBR] << 16) + adr + this.br[X] + 1
          ];
        }

        case ABY: {
          // absolute, indexed by Y for RMW and writes
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          return [
            (this.r[DBR] << 16) + adr + this.br[Y],
            (this.r[DBR] << 16) + adr + this.br[Y] + 1
          ];
        }

        case ABYr: {
          // absolute, indexed by Y for reads (possible extra cycle)
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          if(((adr >> 8) !== ((adr + this.br[Y]) >> 8)) || !this.x) {
            // if page crossed or x is 0: 1 extra cycle
            this.cyclesLeft++;
          }
          return [
            (this.r[DBR] << 16) + adr + this.br[Y],
            (this.r[DBR] << 16) + adr + this.br[Y] + 1
          ];
        }

        case ABL: {
          // absoulte long
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 16;
          return [adr, adr + 1];
        }

        case ALX: {
          // absoulte long indexed
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 16;
          return [adr + this.br[X], adr + this.br[X] + 1];
        }

        case IND: {
          // indirect
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          let pointer = this.mem.read(adr);
          pointer |= this.mem.read((adr + 1) & 0xffff) << 8;
          return [(this.r[K] << 16) + pointer, 0];
        }

        case IAX: {
          // indirect indexed
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          let pointer = this.mem.read(
            (this.r[K] << 16) | ((adr + this.br[X]) & 0xffff)
          );
          pointer |= this.mem.read(
            (this.r[K] << 16) | ((adr + this.br[X] + 1) & 0xffff)
          ) << 8;
          return [(this.r[K] << 16) + pointer, 0];
        }

        case IAL: {
          // indirect long
          let adr = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          adr |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          let pointer = this.mem.read(adr);
          pointer |= this.mem.read((adr + 1) & 0xffff) << 8;
          pointer |= this.mem.read((adr + 2) & 0xffff) << 16;
          return [pointer, 0];
        }

        case REL: {
          // relative
          let rel = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          return [this.getSigned(rel, true), 0];
        }

        case RLL: {
          // relative long
          let rel = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          rel |= this.mem.read((this.r[K] << 16) | this.br[PC]++) << 8;
          return [this.getSigned(rel, false), 0];
        }

        case BM: {
          // block move
          let dest = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          let src = this.mem.read((this.r[K] << 16) | this.br[PC]++);
          return [dest, src];
        }
      }
    }

    // instruction functions

    this.uni = function(adr, adrh, instr) {
      // unimplemented
      console.log(
        "Uninplemented instruction: " + instr.toString(16) +
        " reading at adrl " + adr.toString(16) +
        " and adrh " + adrh.toString(16)
      );
    }

    this.adc = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        let result;
        if(this.d) {
          result = (this.br[A] & 0xf) + (value & 0xf) + (this.c ? 1 : 0);
          result += result > 9 ? 6 : 0;
          result = (
            (this.br[A] & 0xf0) + (value & 0xf0) +
            (result > 0xf ? 0x10 : 0) + (result & 0xf)
          );
        } else {
          result = (this.br[A] & 0xff) + value + (this.c ? 1 : 0);
        }
        this.v = (
          (this.br[A] & 0x80) === (value & 0x80) &&
          (value & 0x80) !== (result & 0x80)
        )
        result += (this.d && result > 0x9f) ? 0x60 : 0;
        this.c = result > 0xff;
        this.setZandN(result, this.m);
        this.br[A] = (this.br[A] & 0xff00) | (result & 0xff);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft++; // 1 extra cycle if m = 0
        let result;
        if(this.d) {
          result = (this.br[A] & 0xf) + (value & 0xf) + (this.c ? 1 : 0);
          result += result > 9 ? 6 : 0;
          result = (
            (this.br[A] & 0xf0) + (value & 0xf0) +
            (result > 0xf ? 0x10 : 0) + (result & 0xf)
          );
          result += result > 0x9f ? 0x60 : 0;
          result = (
            (this.br[A] & 0xf00) + (value & 0xf00) +
            (result > 0xff ? 0x100 : 0) + (result & 0xff)
          );
          result += result > 0x9ff ? 0x600 : 0;
          result = (
            (this.br[A] & 0xf000) + (value & 0xf000) +
            (result > 0xfff ? 0x1000 : 0) + (result & 0xfff)
          );
        } else {
          result = this.br[A] + value + (this.c ? 1 : 0);
        }
        this.v = (
          (this.br[A] & 0x8000) === (value & 0x8000) &&
          (value & 0x8000) !== (result & 0x8000)
        )
        result += (this.d && result > 0x9fff) ? 0x6000 : 0;
        this.c = result > 0xffff;
        this.setZandN(result, this.m);
        this.br[A] = result;
      }
    }

    this.sbc = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr) ^ 0xff;
        let result;
        if(this.d) {
          result = (this.br[A] & 0xf) + (value & 0xf) + (this.c ? 1 : 0);
          result -= result <= 0xf ? 6 : 0;
          result = (
            (this.br[A] & 0xf0) + (value & 0xf0) +
            (result > 0xf ? 0x10 : 0) + (result & 0xf)
          );
        } else {
          result = (this.br[A] & 0xff) + value + (this.c ? 1 : 0);
        }
        this.v = (
          (this.br[A] & 0x80) === (value & 0x80) &&
          (value & 0x80) !== (result & 0x80)
        )
        result -= (this.d && result <= 0xff) ? 0x60 : 0;
        this.c = result > 0xff;
        this.setZandN(result, this.m);
        this.br[A] = (this.br[A] & 0xff00) | (result & 0xff);
      } else {
        let value = this.readWord(adr, adrh) ^ 0xffff;
        this.cyclesLeft++; // 1 extra cycle if m = 0
        let result;
        if(this.d) {
          result = (this.br[A] & 0xf) + (value & 0xf) + (this.c ? 1 : 0);
          result -= result <= 0x0f ? 6 : 0;
          result = (
            (this.br[A] & 0xf0) + (value & 0xf0) +
            (result > 0xf ? 0x10 : 0) + (result & 0xf)
          );
          result -= result <= 0xff ? 0x60 : 0;
          result = (
            (this.br[A] & 0xf00) + (value & 0xf00) +
            (result > 0xff ? 0x100 : 0) + (result & 0xff)
          );
          result -= result <= 0xfff ? 0x600 : 0;
          result = (
            (this.br[A] & 0xf000) + (value & 0xf000) +
            (result > 0xfff ? 0x1000 : 0) + (result & 0xfff)
          );
        } else {
          result = this.br[A] + value + (this.c ? 1 : 0);
        }
        this.v = (
          (this.br[A] & 0x8000) === (value & 0x8000) &&
          (value & 0x8000) !== (result & 0x8000)
        )
        result -= (this.d && result <= 0xffff) ? 0x6000 : 0;
        this.c = result > 0xffff;
        this.setZandN(result, this.m);
        this.br[A] = result;
      }
    }

    this.cmp = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr) ^ 0xff;
        let result = (this.br[A] & 0xff) + value + 1;
        this.c = result > 0xff;
        this.setZandN(result, this.m);
      } else {
        let value = this.readWord(adr, adrh) ^ 0xffff;
        this.cyclesLeft++; // 1 extra cycle if m = 0
        let result = this.br[A] + value + 1;
        this.c = result > 0xffff;
        this.setZandN(result, this.m);
      }
    }

    this.cpx = function(adr, adrh) {
      if(this.x) {
        let value = this.mem.read(adr) ^ 0xff;
        let result = (this.br[X] & 0xff) + value + 1;
        this.c = result > 0xff;
        this.setZandN(result, this.x);
      } else {
        let value = this.readWord(adr, adrh) ^ 0xffff;
        this.cyclesLeft++; // 1 extra cycle if x = 0
        let result = this.br[X] + value + 1;
        this.c = result > 0xffff;
        this.setZandN(result, this.x);
      }
    }

    this.cpy = function(adr, adrh) {
      if(this.x) {
        let value = this.mem.read(adr) ^ 0xff;
        let result = (this.br[Y] & 0xff) + value + 1;
        this.c = result > 0xff;
        this.setZandN(result, this.x);
      } else {
        let value = this.readWord(adr, adrh) ^ 0xffff;
        this.cyclesLeft++; // 1 extra cycle if x = 0
        let result = this.br[Y] + value + 1;
        this.c = result > 0xffff;
        this.setZandN(result, this.x);
      }
    }

    this.dec = function(adr, adrh) {
      if(this.m) {
        let result = (this.mem.read(adr) - 1) & 0xff;
        this.setZandN(result, this.m);
        this.mem.write(adr, result);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft += 2; // 2 extra cycles if m = 0
        let result = (value - 1) & 0xffff;
        this.setZandN(result, this.m);
        this.writeWord(adr, adrh, result, true);
      }
    }

    this.deca = function(adr, adrh) {
      if(this.m) {
        let result = ((this.br[A] & 0xff) - 1) & 0xff;
        this.setZandN(result, this.m);
        this.br[A] = this.br[A] & 0xff00 | result;
      } else {
        this.br[A]--;
        this.setZandN(this.br[A], this.m);
      }
    }

    this.dex = function(adr, adrh) {
      if(this.x) {
        let result = ((this.br[X] & 0xff) - 1) & 0xff;
        this.setZandN(result, this.x);
        this.br[X] = result;
      } else {
        this.br[X]--;
        this.setZandN(this.br[X], this.x);
      }
    }

    this.dey = function(adr, adrh) {
      if(this.x) {
        let result = ((this.br[Y] & 0xff) - 1) & 0xff;
        this.setZandN(result, this.x);
        this.br[Y] = result;
      } else {
        this.br[Y]--;
        this.setZandN(this.br[Y], this.x);
      }
    }

    this.inc = function(adr, adrh) {
      if(this.m) {
        let result = (this.mem.read(adr) + 1) & 0xff;
        this.setZandN(result, this.m);
        this.mem.write(adr, result);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft += 2; // 2 extra cycles if m = 0
        let result = (value + 1) & 0xffff;
        this.setZandN(result, this.m);
        this.writeWord(adr, adrh, result, true);
      }
    }

    this.inca = function(adr, adrh) {
      if(this.m) {
        let result = ((this.br[A] & 0xff) + 1) & 0xff;
        this.setZandN(result, this.m);
        this.br[A] = this.br[A] & 0xff00 | result;
      } else {
        this.br[A]++;
        this.setZandN(this.br[A], this.m);
      }
    }

    this.inx = function(adr, adrh) {
      if(this.x) {
        let result = ((this.br[X] & 0xff) + 1) & 0xff;
        this.setZandN(result, this.x);
        this.br[X] = result;
      } else {
        this.br[X]++;
        this.setZandN(this.br[X], this.x);
      }
    }

    this.iny = function(adr, adrh) {
      if(this.x) {
        let result = ((this.br[Y] & 0xff) + 1) & 0xff;
        this.setZandN(result, this.x);
        this.br[Y] = result;
      } else {
        this.br[Y]++;
        this.setZandN(this.br[Y], this.x);
      }
    }

    this.and = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        this.br[A] = (this.br[A] & 0xff00) | ((this.br[A] & value) & 0xff);
        this.setZandN(this.br[A], this.m);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft++; // 1 extra cycle if m = 0
        this.br[A] &= value;
        this.setZandN(this.br[A], this.m);
      }
    }

    this.eor = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        this.br[A] = (this.br[A] & 0xff00) | ((this.br[A] ^ value) & 0xff);
        this.setZandN(this.br[A], this.m);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft++; // 1 extra cycle if m = 0
        this.br[A] ^= value;
        this.setZandN(this.br[A], this.m);
      }
    }

    this.ora = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        this.br[A] = (this.br[A] & 0xff00) | ((this.br[A] | value) & 0xff);
        this.setZandN(this.br[A], this.m);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft++; // 1 extra cycle if m = 0
        this.br[A] |= value;
        this.setZandN(this.br[A], this.m);
      }
    }

    this.bit = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        let result = (this.br[A] & 0xff) & value;
        this.z = result === 0;
        this.n = (value & 0x80) > 0;
        this.v = (value & 0x40) > 0;
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft++; // 1 extra cycle if m = 0
        let result = this.br[A] & value;
        this.z = result === 0;
        this.n = (value & 0x8000) > 0;
        this.v = (value & 0x4000) > 0;
      }
    }

    this.biti = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        let result = (this.br[A] & 0xff) & value;
        this.z = result === 0;
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft++; // 1 extra cycle if m = 0
        let result = this.br[A] & value;
        this.z = result === 0;
      }
    }

    this.trb = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        let result = (this.br[A] & 0xff) & value;
        value = (value & ~(this.br[A] & 0xff)) & 0xff;
        this.z = result === 0;
        this.mem.write(adr, value);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        let result = this.br[A] & value;
        value = (value & ~this.br[A]) & 0xffff;
        this.z = result === 0;
        this.writeWord(adr, adrh, value, true);
      }
    }

    this.tsb = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        let result = (this.br[A] & 0xff) & value;
        value = (value | (this.br[A] & 0xff)) & 0xff;
        this.z = result === 0;
        this.mem.write(adr, value);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        let result = this.br[A] & value;
        value = (value | this.br[A]) & 0xffff;
        this.z = result === 0;
        this.writeWord(adr, adrh, value, true);
      }
    }

    this.asl = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        this.c = (value & 0x80) > 0;
        value <<= 1;
        this.setZandN(value, this.m);
        this.mem.write(adr, value);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        this.c = (value & 0x8000) > 0;
        value <<= 1;
        this.setZandN(value, this.m);
        this.writeWord(adr, adrh, value, true);
      }
    }

    this.asla = function(adr, adrh) {
      if(this.m) {
        let value = this.br[A] & 0xff;
        this.c = (value & 0x80) > 0;
        value <<= 1;
        this.setZandN(value, this.m);
        this.br[A] = (this.br[A] & 0xff00) | (value & 0xff);
      } else {
        this.c = (this.br[A] & 0x8000) > 0;
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        this.br[A] <<= 1;
        this.setZandN(this.br[A], this.m);
      }
    }

    this.lsr = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        this.c = (value & 0x1) > 0;
        value >>= 1;
        this.setZandN(value, this.m);
        this.mem.write(adr, value);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        this.c = (value & 0x1) > 0;
        value >>= 1;
        this.setZandN(value, this.m);
        this.writeWord(adr, adrh, value, true);
      }
    }

    this.lsra = function(adr, adrh) {
      if(this.m) {
        let value = this.br[A] & 0xff;
        this.c = (value & 0x1) > 0;
        value >>= 1;
        this.setZandN(value, this.m);
        this.br[A] = (this.br[A] & 0xff00) | (value & 0xff);
      } else {
        this.c = (this.br[A] & 0x1) > 0;
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        this.br[A] >>= 1;
        this.setZandN(this.br[A], this.m);
      }
    }

    this.rol = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        value = (value << 1) | (this.c ? 1 : 0);
        this.c = (value & 0x100) > 0;
        this.setZandN(value, this.m);
        this.mem.write(adr, value);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        value = (value << 1) | (this.c ? 1 : 0);
        this.c = (value & 0x10000) > 0;
        this.setZandN(value, this.m);
        this.writeWord(adr, adrh, value, true);
      }
    }

    this.rola = function(adr, adrh) {
      if(this.m) {
        let value = this.br[A] & 0xff;
        value = (value << 1) | (this.c ? 1 : 0);
        this.c = (value & 0x100) > 0;
        this.setZandN(value, this.m);
        this.br[A] = (this.br[A] & 0xff00) | (value & 0xff);
      } else {
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        let value = (this.br[A] << 1) | (this.c ? 1 : 0);
        this.c = (value & 0x10000) > 0;
        this.setZandN(value, this.m);
        this.br[A] = value;
      }
    }

    this.ror = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        let carry = value & 0x1;
        value = (value >> 1) | (this.c ? 0x80 : 0);
        this.c = carry > 0;
        this.setZandN(value, this.m);
        this.mem.write(adr, value);
      } else {
        let value = this.readWord(adr, adrh);
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        let carry = value & 0x1;
        value = (value >> 1) | (this.c ? 0x8000 : 0);
        this.c = carry > 0;
        this.setZandN(value, this.m);
        this.writeWord(adr, adrh, value, true);
      }
    }

    this.rora = function(adr, adrh) {
      if(this.m) {
        let value = this.br[A] & 0xff;
        let carry = value & 0x1;
        value = (value >> 1) | (this.c ? 0x80 : 0);
        this.c = carry > 0;
        this.setZandN(value, this.m);
        this.br[A] = (this.br[A] & 0xff00) | (value & 0xff);
      } else {
        this.cyclesLeft += 2 // 2 extra cycles if m = 0
        let carry = this.br[A] & 0x1;
        let value = (this.br[A] >> 1) | (this.c ? 0x8000 : 0);
        this.c = carry > 0;
        this.setZandN(value, this.m);
        this.br[A] = value;
      }
    }

    this.bcc = function(adr, adrh) {
      this.doBranch(!this.c, adr);
    }

    this.bcs = function(adr, adrh) {
      this.doBranch(this.c, adr);
    }

    this.beq = function(adr, adrh) {
      this.doBranch(this.z, adr);
    }

    this.bmi = function(adr, adrh) {
      this.doBranch(this.n, adr);
    }

    this.bne = function(adr, adrh) {
      this.doBranch(!this.z, adr);
    }

    this.bpl = function(adr, adrh) {
      this.doBranch(!this.n, adr);
    }

    this.bra = function(adr, adrh) {
      this.br[PC] += adr;
    }

    this.bvc = function(adr, adrh) {
      this.doBranch(!this.v, adr);
    }

    this.bvs = function(adr, adrh) {
      this.doBranch(this.v, adr);
    }

    this.brl = function(adr, adrh) {
      this.br[PC] += adr;
    }

    this.jmp = function(adr, adrh) {
      this.br[PC] = adr & 0xffff;
    }

    this.jml = function(adr, adrh) {
      this.r[K] = (adr & 0xff0000) >> 16;
      this.br[PC] = adr & 0xffff;
    }

    this.jsl = function(adr, adrh) {
      let pushPc = (this.br[PC] - 1) & 0xffff;
      this.pushByte(this.r[K]);
      this.pushWord(pushPc);
      this.r[K] = (adr & 0xff0000) >> 16;
      this.br[PC] = adr & 0xffff;
    }

    this.jsr = function(adr, adrh) {
      let pushPc = (this.br[PC] - 1) & 0xffff;
      this.pushWord(pushPc);
      this.br[PC] = adr & 0xffff;
    }

    this.rtl = function(adr, adrh) {
      let pullPc = this.pullWord();
      this.r[K] = this.pullByte();
      this.br[PC] = pullPc + 1;
    }

    this.rts = function(adr, adrh) {
      let pullPc = this.pullWord();
      this.br[PC] = pullPc + 1;
    }

    this.brk = function(adr, adrh) {
      let pushPc = (this.br[PC] + 1) & 0xffff;
      this.pushByte(this.r[K]);
      this.pushWord(pushPc);
      this.pushByte(this.getP());
      this.cyclesLeft++; // native mode: 1 extra cycle
      this.i = true;
      this.d = false;
      this.r[K] = 0;
      this.br[PC] = this.mem.read(0xffe6) | (this.mem.read(0xffe7) << 8);
    }

    this.cop = function(adr, adrh) {
      this.pushByte(this.r[K]);
      this.pushWord(this.br[PC]);
      this.pushByte(this.getP());
      this.cyclesLeft++; // native mode: 1 extra cycle
      this.i = true;
      this.d = false;
      this.r[K] = 0;
      this.br[PC] = this.mem.read(0xffe4) | (this.mem.read(0xffe5) << 8);
    }

    this.abo = function(adr, adrh) {
      this.pushByte(this.r[K]);
      this.pushWord(this.br[PC]);
      this.pushByte(this.getP());
      this.cyclesLeft++; // native mode: 1 extra cycle
      this.i = true;
      this.d = false;
      this.r[K] = 0;
      this.br[PC] = this.mem.read(0xffe8) | (this.mem.read(0xffe9) << 8);
    }

    this.nmi = function(adr, adrh) {
      this.pushByte(this.r[K]);
      this.pushWord(this.br[PC]);
      this.pushByte(this.getP());
      this.cyclesLeft++; // native mode: 1 extra cycle
      this.i = true;
      this.d = false;
      this.r[K] = 0;
      this.br[PC] = this.mem.read(0xffea) | (this.mem.read(0xffeb) << 8);
    }

    this.irq = function(adr, adrh) {
      this.pushByte(this.r[K]);
      this.pushWord(this.br[PC]);
      this.pushByte(this.getP());
      this.cyclesLeft++; // native mode: 1 extra cycle
      this.i = true;
      this.d = false;
      this.r[K] = 0;
      this.br[PC] = this.mem.read(0xffee) | (this.mem.read(0xffef) << 8);
    }

    this.rti = function(adr, adrh) {
      this.setP(this.pullByte());
      this.cyclesLeft++; // native mode: 1 extra cycle
      let pullPc = this.pullWord();
      this.r[K] = this.pullByte();
      this.br[PC] = pullPc;
    }

    this.clc = function(adr, adrh) {
      this.c = false;
    }

    this.cld = function(adr, adrh) {
      this.d = false;
    }

    this.cli = function(adr, adrh) {
      this.i = false;
    }

    this.clv = function(adr, adrh) {
      this.v = false;
    }

    this.sec = function(adr, adrh) {
      this.c = true;
    }

    this.sed = function(adr, adrh) {
      this.d = true;
    }

    this.sei = function(adr, adrh) {
      this.i = true;
    }

    this.rep = function(adr, adrh) {
      let value = this.mem.read(adr);
      this.setP(this.getP() & ~value);
    }

    this.sep = function(adr, adrh) {
      let value = this.mem.read(adr);
      this.setP(this.getP() | value);
    }

    this.lda = function(adr, adrh) {
      if(this.m) {
        let value = this.mem.read(adr);
        this.br[A] = (this.br[A] & 0xff00) | (value & 0xff);
        this.setZandN(value, this.m);
      } else {
        this.cyclesLeft++; // m = 0: 1 extra cycle
        this.br[A] = this.readWord(adr, adrh);
        this.setZandN(this.br[A], this.m);
      }
    }

    this.ldx = function(adr, adrh) {
      if(this.x) {
        this.br[X] = this.mem.read(adr);
        this.setZandN(this.br[X], this.x);
      } else {
        this.cyclesLeft++; // x = 0: 1 extra cycle
        this.br[X] = this.readWord(adr, adrh);
        this.setZandN(this.br[X], this.x);
      }
    }

    this.ldy = function(adr, adrh) {
      if(this.x) {
        this.br[Y] = this.mem.read(adr);
        this.setZandN(this.br[Y], this.x);
      } else {
        this.cyclesLeft++; // x = 0: 1 extra cycle
        this.br[Y] = this.readWord(adr, adrh);
        this.setZandN(this.br[Y], this.x);
      }
    }

    this.sta = function(adr, adrh) {
      if(this.m) {
        this.mem.write(adr, this.br[A] & 0xff);
      } else {
        this.cyclesLeft++; // m = 0: 1 extra cycle
        this.writeWord(adr, adrh, this.br[A]);
      }
    }

    this.stx = function(adr, adrh) {
      if(this.x) {
        this.mem.write(adr, this.br[X] & 0xff);
      } else {
        this.cyclesLeft++; // x = 0: 1 extra cycle
        this.writeWord(adr, adrh, this.br[X]);
      }
    }

    this.sty = function(adr, adrh) {
      if(this.x) {
        this.mem.write(adr, this.br[Y] & 0xff);
      } else {
        this.cyclesLeft++; // x = 0: 1 extra cycle
        this.writeWord(adr, adrh, this.br[Y]);
      }
    }

    this.stz = function(adr, adrh) {
      if(this.m) {
        this.mem.write(adr, 0);
      } else {
        this.cyclesLeft++; // m = 0: 1 extra cycle
        this.writeWord(adr, adrh, 0);
      }
    }

    this.mvn = function(adr, adrh) {
      this.r[DBR] = adr;
      this.mem.write(
        (adr << 16) | this.br[Y],
        this.mem.read((adrh << 16) | this.br[X])
      );
      this.br[A]--;
      this.br[X]++;
      this.br[Y]++;
      if(this.br[A] !== 0xffff) {
        this.br[PC] -= 3;
      }
      if(this.x) {
        this.br[X] &= 0xff;
        this.br[Y] &= 0xff;
      }
    }

    this.mvp = function(adr, adrh) {
      this.r[DBR] = adr;
      this.mem.write(
        (adr << 16) | this.br[Y],
        this.mem.read((adrh << 16) | this.br[X])
      );
      this.br[A]--;
      this.br[X]--;
      this.br[Y]--;
      if(this.br[A] !== 0xffff) {
        this.br[PC] -= 3;
      }
      if(this.x) {
        this.br[X] &= 0xff;
        this.br[Y] &= 0xff;
      }
    }

    this.nop = function(adr, adrh) {
      // no operation
    }

    this.wdm = function(adr, adrh) {
      // no operation
    }

    this.pea = function(adr, adrh) {
      this.pushWord(this.readWord(adr, adrh));
    }

    this.pei = function(adr, adrh) {
      this.pushWord(this.readWord(adr, adrh));
    }

    this.per = function(adr, adrh) {
      this.pushWord((this.br[PC] + adr) & 0xffff);
    }

    this.pha = function(adr, adrh) {
      if(this.m) {
        this.pushByte(this.br[A] & 0xff);
      } else {
        this.cyclesLeft++; // m = 0: 1 extra cycle
        this.pushWord(this.br[A]);
      }
    }

    this.phx = function(adr, adrh) {
      if(this.x) {
        this.pushByte(this.br[X] & 0xff);
      } else {
        this.cyclesLeft++; // x = 0: 1 extra cycle
        this.pushWord(this.br[X]);
      }
    }

    this.phy = function(adr, adrh) {
      if(this.x) {
        this.pushByte(this.br[Y] & 0xff);
      } else {
        this.cyclesLeft++; // x = 0: 1 extra cycle
        this.pushWord(this.br[Y]);
      }
    }

    this.pla = function(adr, adrh) {
      if(this.m) {
        this.br[A] = (this.br[A] & 0xff00) | (this.pullByte() & 0xff);
        this.setZandN(this.br[A], this.m);
      } else {
        this.cyclesLeft++; // m = 0: 1 extra cycle
        this.br[A] = this.pullWord();
        this.setZandN(this.br[A], this.m);
      }
    }

    this.plx = function(adr, adrh) {
      if(this.x) {
        this.br[X] = this.pullByte();
        this.setZandN(this.br[X], this.x);
      } else {
        this.cyclesLeft++; // x = 0: 1 extra cycle
        this.br[X] = this.pullWord();
        this.setZandN(this.br[X], this.x);
      }
    }

    this.ply = function(adr, adrh) {
      if(this.x) {
        this.br[Y] = this.pullByte();
        this.setZandN(this.br[Y], this.x);
      } else {
        this.cyclesLeft++; // x = 0: 1 extra cycle
        this.br[Y] = this.pullWord();
        this.setZandN(this.br[Y], this.x);
      }
    }

    this.phb = function(adr, adrh) {
      this.pushByte(this.r[DBR]);
    }

    this.phd = function(adr, adrh) {
      this.pushWord(this.br[DPR]);
    }

    this.phk = function(adr, adrh) {
      this.pushByte(this.r[K]);
    }

    this.php = function(adr, adrh) {
      this.pushByte(this.getP());
    }

    this.plb = function(adr, adrh) {
      this.r[DBR] = this.pullByte();
      this.setZandN(this.r[DBR], true);
    }

    this.pld = function(adr, adrh) {
      this.br[DPR] = this.pullWord();
      this.setZandN(this.br[DPR], false);
    }

    this.plp = function(adr, adrh) {
      this.setP(this.pullByte());
    }

    this.stp = function(adr, adrh) {
      this.stopped = true;
    }

    this.wai = function(adr, adrh) {
      this.waiting = true;
    }

    this.tax = function(adr, adrh) {
      if(this.x) {
        this.br[X] = this.br[A] & 0xff;
        this.setZandN(this.br[X], this.x);
      } else {
        this.br[X] = this.br[A];
        this.setZandN(this.br[X], this.x);
      }
    }

    this.tay = function(adr, adrh) {
      if(this.x) {
        this.br[Y] = this.br[A] & 0xff;
        this.setZandN(this.br[Y], this.x);
      } else {
        this.br[Y] = this.br[A];
        this.setZandN(this.br[Y], this.x);
      }
    }

    this.tsx = function(adr, adrh) {
      if(this.x) {
        this.br[X] = this.br[SP] & 0xff;
        this.setZandN(this.br[X], this.x);
      } else {
        this.br[X] = this.br[SP];
        this.setZandN(this.br[X], this.x);
      }
    }

    this.txa = function(adr, adrh) {
      if(this.m) {
        this.br[A] = (this.br[A] & 0xff00) | (this.br[X] & 0xff);
        this.setZandN(this.br[A], this.m);
      } else {
        this.br[A] = this.br[X];
        this.setZandN(this.br[A], this.m);
      }
    }

    this.txs = function(adr, adrh) {
      this.br[SP] = this.br[X];
    }

    this.txy = function(adr, adrh) {
      if(this.x) {
        this.br[Y] = this.br[X] & 0xff;
        this.setZandN(this.br[Y], this.x);
      } else {
        this.br[Y] = this.br[X];
        this.setZandN(this.br[Y], this.x);
      }
    }

    this.tya = function(adr, adrh) {
      if(this.m) {
        this.br[A] = (this.br[A] & 0xff00) | (this.br[Y] & 0xff);
        this.setZandN(this.br[A], this.m);
      } else {
        this.br[A] = this.br[Y];
        this.setZandN(this.br[A], this.m);
      }
    }

    this.tyx = function(adr, adrh) {
      if(this.x) {
        this.br[X] = this.br[Y] & 0xff;
        this.setZandN(this.br[X], this.x);
      } else {
        this.br[X] = this.br[Y];
        this.setZandN(this.br[X], this.x);
      }
    }

    this.tcd = function(adr, adrh) {
      this.br[DPR] = this.br[A];
      this.setZandN(this.br[DPR], false);
    }

    this.tcs = function(adr, adrh) {
      this.br[SP] = this.br[A];
    }

    this.tdc = function(adr, adrh) {
      this.br[A] = this.br[DPR];
      this.setZandN(this.br[A], false);
    }

    this.tsc = function(adr, adrh) {
      this.br[A] = this.br[SP];
      this.setZandN(this.br[A], false);
    }

    this.xba = function(adr, adrh) {
      let low = this.br[A] & 0xff;
      let high = (this.br[A] & 0xff00) >> 8;
      this.br[A] = (low << 8) | high;
      this.setZandN(this.br[A], true);
    }

    this.xce = function(adr, adrh) {
      let temp = this.c;
      this.c = this.e;
      this.e = temp;
      if(this.e) {
        this.m = true;
        this.x = true;
      }
      if(this.x) {
        this.br[X] &= 0xff;
        this.br[Y] &= 0xff;
      }
    }

    // function table
    this.functions = [
      this.brk, this.ora, this.cop, this.ora, this.tsb, this.ora, this.asl, this.ora, this.php, this.ora, this.asla,this.phd, this.tsb, this.ora, this.asl, this.ora,
      this.bpl, this.ora, this.ora, this.ora, this.trb, this.ora, this.asl, this.ora, this.clc, this.ora, this.inca,this.tcs, this.trb, this.ora, this.asl, this.ora,
      this.jsr, this.and, this.jsl, this.and, this.bit, this.and, this.rol, this.and, this.plp, this.and, this.rola,this.pld, this.bit, this.and, this.rol, this.and,
      this.bmi, this.and, this.and, this.and, this.bit, this.and, this.rol, this.and, this.sec, this.and, this.deca,this.tsc, this.bit, this.and, this.rol, this.and,
      this.rti, this.eor, this.wdm, this.eor, this.mvp, this.eor, this.lsr, this.eor, this.pha, this.eor, this.lsra,this.phk, this.jmp, this.eor, this.lsr, this.eor,
      this.bvc, this.eor, this.eor, this.eor, this.mvn, this.eor, this.lsr, this.eor, this.cli, this.eor, this.phy, this.tcd, this.jml, this.eor, this.lsr, this.eor,
      this.rts, this.adc, this.per, this.adc, this.stz, this.adc, this.ror, this.adc, this.pla, this.adc, this.rora,this.rtl, this.jmp, this.adc, this.ror, this.adc,
      this.bvs, this.adc, this.adc, this.adc, this.stz, this.adc, this.ror, this.adc, this.sei, this.adc, this.ply, this.tdc, this.jmp, this.adc, this.ror, this.adc,
      this.bra, this.sta, this.brl, this.sta, this.sty, this.sta, this.stx, this.sta, this.dey, this.biti,this.txa, this.phb, this.sty, this.sta, this.stx, this.sta,
      this.bcc, this.sta, this.sta, this.sta, this.sty, this.sta, this.stx, this.sta, this.tya, this.sta, this.txs, this.txy, this.stz, this.sta, this.stz, this.sta,
      this.ldy, this.lda, this.ldx, this.lda, this.ldy, this.lda, this.ldx, this.lda, this.tay, this.lda, this.tax, this.plb, this.ldy, this.lda, this.ldx, this.lda,
      this.bcs, this.lda, this.lda, this.lda, this.ldy, this.lda, this.ldx, this.lda, this.clv, this.lda, this.tsx, this.tyx, this.ldy, this.lda, this.ldx, this.lda,
      this.cpy, this.cmp, this.rep, this.cmp, this.cpy, this.cmp, this.dec, this.cmp, this.iny, this.cmp, this.dex, this.wai, this.cpy, this.cmp, this.dec, this.cmp,
      this.bne, this.cmp, this.cmp, this.cmp, this.pei, this.cmp, this.dec, this.cmp, this.cld, this.cmp, this.phx, this.stp, this.jml, this.cmp, this.dec, this.cmp,
      this.cpx, this.sbc, this.sep, this.sbc, this.cpx, this.sbc, this.inc, this.sbc, this.inx, this.sbc, this.nop, this.xba, this.cpx, this.sbc, this.inc, this.sbc,
      this.beq, this.sbc, this.sbc, this.sbc, this.pea, this.sbc, this.inc, this.sbc, this.sed, this.sbc, this.plx, this.xce, this.jsr, this.sbc, this.inc, this.sbc,
      this.abo, this.nmi, this.irq // abo, nmi, irq
    ];

  }
})();

function Snes() {

  this.cpu = new Cpu(this);

  this.ppu = new Ppu(this);

  this.apu = new Apu(this);

  this.ram = new Uint8Array(0x20000);

  this.cart = undefined;

  this.dmaOffs = [
    0, 0, 0, 0,
    0, 1, 0, 1,
    0, 0, 0, 0,
    0, 0, 1, 1,
    0, 1, 2, 3,
    0, 1, 0, 1,
    0, 0, 0, 0,
    0, 0, 1, 1
  ]

  this.dmaOffLengths = [1, 2, 2, 4, 4, 4, 2, 4];

  this.apuCyclesPerMaster = (32040 * 32) / (1364 * 262 * 60);

  // for dma
  this.dmaBadr = new Uint8Array(8);
  this.dmaAadr = new Uint16Array(8);
  this.dmaAadrBank = new Uint8Array(8);
  this.dmaSize = new Uint16Array(8);
  this.hdmaIndBank = new Uint8Array(8);
  this.hdmaTableAdr = new Uint16Array(8);
  this.hdmaRepCount = new Uint8Array(8);
  this.dmaUnusedByte = new Uint8Array(8);

  this.reset = function(hard) {
    if(hard) {
      clearArray(this.ram);
    }
    clearArray(this.dmaBadr);
    clearArray(this.dmaAadr);
    clearArray(this.dmaAadrBank);
    clearArray(this.dmaSize);
    clearArray(this.hdmaIndBank);
    clearArray(this.hdmaTableAdr);
    clearArray(this.hdmaRepCount);
    clearArray(this.dmaUnusedByte);

    this.cpu.reset();
    this.ppu.reset();
    this.apu.reset();
    if(this.cart) {
      this.cart.reset(hard);
    }

    this.xPos = 0;
    this.yPos = 0;
    this.frames = 0;

    this.cpuCyclesLeft = 5 * 8 + 12; // reset: 5 read cycles + 2 IO cycles
    this.cpuMemOps = 0;
    this.apuCatchCycles = 0;

    // for cpu-ports
    this.ramAdr = 0;

    this.hIrqEnabled = false;
    this.vIrqEnabled = false;
    this.nmiEnabled = false;
    this.hTimer = 0x1ff;
    this.vTimer = 0x1ff;
    this.inNmi = false;
    this.inIrq = false;
    this.inHblank = false;
    this.inVblank = false;

    this.autoJoyRead = false;
    this.autoJoyTimer = 0;
    this.ppuLatch = true;

    this.joypad1Val = 0;
    this.joypad2Val = 0;
    this.joypad1AutoRead = 0;
    this.joypad2AutoRead = 0;
    this.joypadStrobe = false;
    this.joypad1State = 0; // current button state
    this.joypad2State = 0; // current button state

    this.multiplyA = 0xff;
    this.divA = 0xffff;
    this.divResult = 0x101;
    this.mulResult = 0xfe01;

    this.fastMem = false;

    // dma and hdma
    this.dmaTimer = 0;
    this.hdmaTimer = 0;
    this.dmaBusy = false;
    this.dmaActive = [false, false, false, false, false, false, false, false];
    this.hdmaActive = [false, false, false, false, false, false, false, false];

    this.dmaMode = [0, 0, 0, 0, 0, 0, 0, 0];
    this.dmaFixed = [false, false, false, false, false, false, false, false];
    this.dmaDec = [false, false, false, false, false, false, false, false];
    this.hdmaInd = [false, false, false, false, false, false, false, false];
    this.dmaFromB = [false, false, false, false, false, false, false, false];
    this.dmaUnusedBit = [false, false, false, false, false, false, false, false];

    this.hdmaDoTransfer = [
      false, false, false, false, false, false, false, false
    ];
    this.hdmaTerminated = [
      false, false, false, false, false, false, false, false
    ];
    this.dmaOffIndex = 0;

    this.openBus = 0;

  }
  this.reset();

  // cycle functions

  this.cycle = function(noPpu) {

    this.apuCatchCycles += (this.apuCyclesPerMaster * 2);

    if(this.joypadStrobe) {
      this.joypad1Val = this.joypad1State;
      this.joypad2Val = this.joypad2State;
    }

    if(this.hdmaTimer > 0) {
      this.hdmaTimer -= 2;
    } else if(this.dmaBusy) {
      this.handleDma();
    } else if(this.xPos < 536 || this.xPos >= 576) {
      // the cpu is paused for 40 cycles starting around dot 536
      this.cpuCycle();
    }

    if(this.yPos === this.vTimer && this.vIrqEnabled) {
      if(!this.hIrqEnabled) {
        // only v irq enabed
        if(this.xPos === 0) {
          this.inIrq = true;
          this.cpu.irqWanted = true;
        }
      } else {
        // v and h irq enabled
        if(this.xPos === (this.hTimer * 4)) {
          this.inIrq = true;
          this.cpu.irqWanted = true;
        }
      }
    } else if (
      this.xPos === (this.hTimer * 4)
      && this.hIrqEnabled && !this.vIrqEnabled
    ) {
      // only h irq enabled
      this.inIrq = true;
      this.cpu.irqWanted = true;
    }

    if(this.xPos === 1024) {
      // start of hblank
      this.inHblank = true;
      if(!this.inVblank) {
        this.handleHdma();
      }
    } else if(this.xPos === 0) {
      // end of hblank
      this.inHblank = false;
      // check if the ppu will render a 239-high frame or not
      this.ppu.checkOverscan(this.yPos);
    } else if(this.xPos === 512 && !noPpu) {
      // render line at cycle 512 for better support
      this.ppu.renderLine(this.yPos);
    }

    if(this.yPos === (this.ppu.frameOverscan ? 240 : 225) && this.xPos === 0) {
      // start of vblank
      this.inNmi = true;
      this.inVblank = true;
      if(this.autoJoyRead) {
        this.autoJoyTimer = 4224;
        this.doAutoJoyRead();
      }
      if(this.nmiEnabled) {
        this.cpu.nmiWanted = true;
      }
    } else if(this.yPos === 0 && this.xPos === 0) {
      // end of vblank
      this.inNmi = false;
      this.inVblank = false;
      this.initHdma();
    }

    if(this.autoJoyTimer > 0) {
      this.autoJoyTimer -= 2; // loop only runs every second master cycle
    }

    // TODO: in non-intelace mode, line 240 on every odd frame is 1360 cycles
    // and in interlace mode, every even frame is 263 lines
    this.xPos += 2;
    if(this.xPos === 1364) {
      this.xPos = 0;
      this.yPos++;
      if(this.yPos === 262) {
        // when finishing a frame, also catch up the apu
        this.catchUpApu();
        this.yPos = 0;
        this.frames++;
      }
    }
  }

  this.cpuCycle = function() {
    if(this.cpuCyclesLeft === 0) {
      this.cpu.cyclesLeft = 0;
      this.cpuMemOps = 0;
      this.cpu.cycle();
      this.cpuCyclesLeft += (this.cpu.cyclesLeft + 1 - this.cpuMemOps) * 6;
    }
    this.cpuCyclesLeft -= 2;
  }

  this.catchUpApu = function() {
    let catchUpCycles = this.apuCatchCycles & 0xffffffff;
    for(let i = 0; i < catchUpCycles; i++) {
      this.apu.cycle();
    }
    this.apuCatchCycles -= catchUpCycles;
  }

  this.runFrame = function(noPpu) {
    do {
      this.cycle(noPpu);
    } while(!(this.xPos === 0 && this.yPos === 0));
    //log("apu position: " + this.apu.dsp.sampleOffset);
  }

  this.doAutoJoyRead = function() {
    this.joypad1AutoRead = 0;
    this.joypad2AutoRead = 0;
    this.joypad1Val = this.joypad1State;
    this.joypad2Val = this.joypad2State;
    for(let i = 0; i < 16; i++) {
      let bit = this.joypad1Val & 0x1;
      this.joypad1Val >>= 1;
      this.joypad1Val |= 0x8000;
      this.joypad1AutoRead |= (bit << (15 - i));
      bit = this.joypad2Val & 0x1;
      this.joypad2Val >>= 1;
      this.joypad2Val |= 0x8000;
      this.joypad2AutoRead |= (bit << (15 - i));
    }
  }

  this.handleDma = function() {
    if(this.dmaTimer > 0) {
      this.dmaTimer -= 2;
      return;
    }
    // loop over each dma channel to find the first active one
    let i;
    for(i = 0; i < 8; i++) {
      if(this.dmaActive[i]) {
        break;
      }
    }
    if(i === 8) {
      // no active channel left, dma is done
      this.dmaBusy = false;
      this.dmaOffIndex = 0;
      //log("Finished DMA");
      return;
    }
    let tableOff = this.dmaMode[i] * 4 + this.dmaOffIndex++;
    this.dmaOffIndex &= 0x3;
    if(this.dmaFromB[i]) {
      this.write(
        (this.dmaAadrBank[i] << 16) | this.dmaAadr[i],
        this.readBBus(
          (this.dmaBadr[i] + this.dmaOffs[tableOff]) & 0xff
        ), true
      );
    } else {
      this.writeBBus(
        (this.dmaBadr[i] + this.dmaOffs[tableOff]) & 0xff,
        this.read((this.dmaAadrBank[i] << 16) | this.dmaAadr[i], true)
      );
    }
    this.dmaTimer += 6;
    // because this run through the function itself also costs 2 master cycles,
    // we have to wait 6 more to get to 8 per byte transferred
    if(!this.dmaFixed[i]) {
      if(this.dmaDec[i]) {
        this.dmaAadr[i]--;
      } else {
        this.dmaAadr[i]++;
      }
    }
    this.dmaSize[i]--;
    if(this.dmaSize[i] === 0) {
      this.dmaOffIndex = 0;
      this.dmaActive[i] = false;
      this.dmaTimer += 8; // 8 extra cycles overhead per channel
    }
  }

  this.initHdma = function() {
    this.hdmaTimer = 18;
    for(let i = 0; i < 8; i++) {
      if(this.hdmaActive[i]) {
        // terminate DMA if it was busy for this channel
        this.dmaActive[i] = false;
        this.dmaOffIndex = 0;

        this.hdmaTableAdr[i] = this.dmaAadr[i];
        this.hdmaRepCount[i] = this.read(
          (this.dmaAadrBank[i] << 16) | this.hdmaTableAdr[i]++, true
        );
        this.hdmaTimer += 8;
        if(this.hdmaInd[i]) {
          this.dmaSize[i] = this.read(
            (this.dmaAadrBank[i] << 16) | this.hdmaTableAdr[i]++, true
          );
          this.dmaSize[i] |= this.read(
            (this.dmaAadrBank[i] << 16) | this.hdmaTableAdr[i]++, true
          ) << 8;
          this.hdmaTimer += 16;
        }
        this.hdmaDoTransfer[i] = true;
      } else {
        this.hdmaDoTransfer[i] = false;
      }
      this.hdmaTerminated[i] = false;
    }
  }

  this.handleHdma = function() {
    this.hdmaTimer = 18;
    for(let i = 0; i < 8; i++) {
      if(this.hdmaActive[i] && !this.hdmaTerminated[i]) {
        // terminate dma if it is busy on this channel
        this.dmaActive[i] = false;
        // this.dmaOffIndex = 0;
        this.hdmaTimer += 8;
        if(this.hdmaDoTransfer[i]) {
          for(let j = 0; j < this.dmaOffLengths[this.dmaMode[i]]; j++) {
            let tableOff = this.dmaMode[i] * 4 + j;
            this.hdmaTimer += 8;
            if(this.hdmaInd[i]) {
              if(this.dmaFromB[i]) {
                this.write(
                  (this.hdmaIndBank[i] << 16) | this.dmaSize[i],
                  this.readBBus(
                    (this.dmaBadr[i] + this.dmaOffs[tableOff]) & 0xff
                  ), true
                );
              } else {
                this.writeBBus(
                  (this.dmaBadr[i] + this.dmaOffs[tableOff]) & 0xff,
                  this.read((this.hdmaIndBank[i] << 16) | this.dmaSize[i], true)
                );
              }
              this.dmaSize[i]++
            } else {
              if(this.dmaFromB[i]) {
                this.write(
                  (this.dmaAadrBank[i] << 16) | this.hdmaTableAdr[i],
                  this.readBBus(
                    (this.dmaBadr[i] + this.dmaOffs[tableOff]) & 0xff
                  ), true
                );
              } else {
                this.writeBBus(
                  (this.dmaBadr[i] + this.dmaOffs[tableOff]) & 0xff,
                  this.read(
                    (this.dmaAadrBank[i] << 16) | this.hdmaTableAdr[i], true
                  )
                );
              }
              this.hdmaTableAdr[i]++;
            }
          }
        }
        this.hdmaRepCount[i]--;
        this.hdmaDoTransfer[i] = (this.hdmaRepCount[i] & 0x80) > 0;
        if((this.hdmaRepCount[i] & 0x7f) === 0) {
          this.hdmaRepCount[i] = this.read(
            (this.dmaAadrBank[i] << 16) | this.hdmaTableAdr[i]++, true
          );
          if(this.hdmaInd[i]) {
            this.dmaSize[i] = this.read(
              (this.dmaAadrBank[i] << 16) | this.hdmaTableAdr[i]++, true
            );
            this.dmaSize[i] |= this.read(
              (this.dmaAadrBank[i] << 16) | this.hdmaTableAdr[i]++, true
            ) << 8;
            this.hdmaTimer += 16;
          }
          if(this.hdmaRepCount[i] === 0) {
            this.hdmaTerminated[i] = true;
          }
          this.hdmaDoTransfer[i] = true;
        }
      }
    }
  }

  // read and write handlers

  this.readReg = function(adr) {
    switch(adr) {
      case 0x4210: {
        let val = 0x2;
        val |= this.inNmi ? 0x80 : 0;
        val |= this.openBus & 0x70;
        this.inNmi = false;
        return val;
      }
      case 0x4211: {
        let val = this.inIrq ? 0x80 : 0;
        val |= this.openBus & 0x7f;
        this.inIrq = false;
        this.cpu.irqWanted = false;
        return val;
      }
      case 0x4212: {
        let val = (this.autoJoyTimer > 0) ? 0x1 : 0;
        val |= this.inHblank ? 0x40 : 0;
        val |= this.inVblank ? 0x80 : 0;
        val |= this.openBus & 0x3e;
        return val;
      }
      case 0x4213: {
        // IO read register
        return this.ppuLatch ? 0x80 : 0;
      }
      case 0x4214: {
        return this.divResult & 0xff;
      }
      case 0x4215: {
        return (this.divResult & 0xff00) >> 8;
      }
      case 0x4216: {
        return this.mulResult & 0xff;
      }
      case 0x4217: {
        return (this.mulResult & 0xff00) >> 8;
      }
      case 0x4218: {
        return this.joypad1AutoRead & 0xff;
      }
      case 0x4219: {
        return (this.joypad1AutoRead & 0xff00) >> 8;
      }
      case 0x421a: {
        return this.joypad2AutoRead & 0xff;
      }
      case 0x421b: {
        return (this.joypad2AutoRead & 0xff00) >> 8;
      }
      case 0x421c:
      case 0x421d:
      case 0x421e:
      case 0x421f: {
        // joypads 3 and 4 not emulated
        return 0;
      }
    }

    if(adr >= 0x4300 && adr < 0x4380) {
      let channel = (adr & 0xf0) >> 4;
      switch(adr & 0xff0f) {
        case 0x4300: {
          let val = this.dmaMode[channel];
          val |= this.dmaFixed[channel] ? 0x8 : 0;
          val |= this.dmaDec[channel] ? 0x10 : 0;
          val |= this.dmaUnusedBit[channel] ? 0x20 : 0;
          val |= this.hdmaInd[channel] ? 0x40 : 0;
          val |= this.dmaFromB[channel] ? 0x80 : 0;
          return val;
        }
        case 0x4301: {
          return this.dmaBadr[channel];
        }
        case 0x4302: {
          return this.dmaAadr[channel] & 0xff;
        }
        case 0x4303: {
          return (this.dmaAadr[channel] & 0xff00) >> 8;
        }
        case 0x4304: {
          return this.dmaAadrBank[channel];
        }
        case 0x4305: {
          return this.dmaSize[channel] & 0xff;
        }
        case 0x4306: {
          return (this.dmaSize[channel] & 0xff00) >> 8;
        }
        case 0x4307: {
          return this.hdmaIndBank[channel];
        }
        case 0x4308: {
          return this.hdmaTableAdr[channel] & 0xff;
        }
        case 0x4309: {
          return (this.hdmaTableAdr[channel] & 0xff00) >> 8;
        }
        case 0x430a: {
          return this.hdmaRepCount[channel];
        }
        case 0x430b:
        case 0x430f: {
          return this.dmaUnusedByte[channel];
        }
      }
    }

    return this.openBus;
  }

  this.writeReg = function(adr, value) {
    switch(adr) {
      case 0x4200: {
        this.autoJoyRead = (value & 0x1) > 0;
        if(!this.autoJoyRead) {
          this.autoJoyTimer = 0;
        }
        this.hIrqEnabled = (value & 0x10) > 0;
        this.vIrqEnabled = (value & 0x20) > 0;
        this.nmiEnabled = (value & 0x80) > 0;
        if(!this.hIrqEnabled && !this.vIrqEnabled) {
          this.cpu.irqWanted = false;
          this.inIrq = false;
        }
        return;
      }
      case 0x4201: {
        // IO port
        if(this.ppuLatch && (value & 0x80) === 0) {
          this.ppu.latchedHpos = this.xPos >> 2;
          this.ppu.latchedVpos = this.yPos;
          this.ppu.countersLatched = true;
        }
        this.ppuLatch = (value & 0x80) > 0;
        return;
      }
      case 0x4202: {
        this.multiplyA = value;
        return;
      }
      case 0x4203: {
        this.mulResult = this.multiplyA * value;
        return;
      }
      case 0x4204: {
        this.divA = (this.divA & 0xff00) | value;
        return;
      }
      case 0x4205: {
        this.divA = (this.divA & 0xff) | (value << 8);
        return;
      }
      case 0x4206: {
        this.divResult = 0xffff;
        this.mulResult = this.divA;
        if(value !== 0) {
          this.divResult = (this.divA / value) & 0xffff;
          this.mulResult = this.divA % value;
        }
        return;
      }
      case 0x4207: {
        this.hTimer = (this.hTimer & 0x100) | value;
        return;
      }
      case 0x4208: {
        this.hTimer = (this.hTimer & 0xff) | ((value & 0x1) << 8);
        return;
      }
      case 0x4209: {
        this.vTimer = (this.vTimer & 0x100) | value;
        return;
      }
      case 0x420a: {
        this.vTimer = (this.vTimer & 0xff) | ((value & 0x1) << 8);
        return;
      }
      case 0x420b: {
        // enable dma
        this.dmaActive[0] = (value & 0x1) > 0;
        this.dmaActive[1] = (value & 0x2) > 0;
        this.dmaActive[2] = (value & 0x4) > 0;
        this.dmaActive[3] = (value & 0x8) > 0;
        this.dmaActive[4] = (value & 0x10) > 0;
        this.dmaActive[5] = (value & 0x20) > 0;
        this.dmaActive[6] = (value & 0x40) > 0;
        this.dmaActive[7] = (value & 0x80) > 0;
        this.dmaBusy = value > 0;
        this.dmaTimer += this.dmaBusy ? 8 : 0;
        return;
      }
      case 0x420c: {
        this.hdmaActive[0] = (value & 0x1) > 0;
        this.hdmaActive[1] = (value & 0x2) > 0;
        this.hdmaActive[2] = (value & 0x4) > 0;
        this.hdmaActive[3] = (value & 0x8) > 0;
        this.hdmaActive[4] = (value & 0x10) > 0;
        this.hdmaActive[5] = (value & 0x20) > 0;
        this.hdmaActive[6] = (value & 0x40) > 0;
        this.hdmaActive[7] = (value & 0x80) > 0;
        return;
      }
      case 0x420d: {
        this.fastMem = (value & 0x1) > 0;
        return;
      }
    }

    if(adr >= 0x4300 && adr < 0x4380) {
      let channel = (adr & 0xf0) >> 4;
      switch(adr & 0xff0f) {
        case 0x4300: {
          this.dmaMode[channel] = value & 0x7;
          this.dmaFixed[channel] = (value & 0x08) > 0;
          this.dmaDec[channel] = (value & 0x10) > 0;
          this.dmaUnusedBit[channel] = (value & 0x20) > 0;
          this.hdmaInd[channel] = (value & 0x40) > 0;
          this.dmaFromB[channel] = (value & 0x80) > 0;
          return;
        }
        case 0x4301: {
          this.dmaBadr[channel] = value;
          return;
        }
        case 0x4302: {
          this.dmaAadr[channel] = (this.dmaAadr[channel] & 0xff00) | value;
          return;
        }
        case 0x4303: {
          this.dmaAadr[channel] = (this.dmaAadr[channel] & 0xff) | (value << 8);
          return;
        }
        case 0x4304: {
          this.dmaAadrBank[channel] = value;
          return;
        }
        case 0x4305: {
          this.dmaSize[channel] = (this.dmaSize[channel] & 0xff00) | value;
          return;
        }
        case 0x4306: {
          this.dmaSize[channel] = (this.dmaSize[channel] & 0xff) | (value << 8);
          return;
        }
        case 0x4307: {
          this.hdmaIndBank[channel] = value;
          return;
        }
        case 0x4308: {
          this.hdmaTableAdr[channel] = (
            this.hdmaTableAdr[channel] & 0xff00
          ) | value;
          return;
        }
        case 0x4309: {
          this.hdmaTableAdr[channel] = (
            this.hdmaTableAdr[channel] & 0xff
          ) | (value << 8);
          return;
        }
        case 0x430a: {
          this.hdmaRepCount[channel] = value;
          return;
        }
        case 0x430b:
        case 0x430f: {
          this.dmaUnusedByte[channel] = value;
          return;
        }
      }
    }
  }

  this.readBBus = function(adr) {
    if(adr > 0x33 && adr < 0x40) {
      return this.ppu.read(adr);
    }
    if(adr >= 0x40 && adr < 0x80) {
      // catch up the apu, then do the read
      this.catchUpApu();
      return this.apu.spcWritePorts[adr & 0x3];
    }
    if(adr === 0x80) {
      let val = this.ram[this.ramAdr++];
      this.ramAdr &= 0x1ffff;
      return val;
    }
    return this.openBus; // rest not readable
  }

  this.writeBBus = function(adr, value) {
    if(adr < 0x34) {
      this.ppu.write(adr, value);
      return;
    }
    if(adr >= 0x40 && adr < 0x80) {
      // catch up the apu, then do the write
      this.catchUpApu();
      this.apu.spcReadPorts[adr & 0x3] = value;
      return;
    }
    switch(adr) {
      case 0x80: {
        this.ram[this.ramAdr++] = value;
        this.ramAdr &= 0x1ffff;
        return;
      }
      case 0x81: {
        this.ramAdr = (this.ramAdr & 0x1ff00) | value;
        return;
      }
      case 0x82: {
        this.ramAdr = (this.ramAdr & 0x100ff) | (value << 8);
        return;
      }
      case 0x83: {
        this.ramAdr = (this.ramAdr & 0x0ffff) | ((value & 1) << 16);
        return;
      }
    }
    return;
  }

  this.rread = function(adr) {
    adr &= 0xffffff;
    let bank = adr >> 16;
    adr &= 0xffff;
    if(bank === 0x7e || bank === 0x7f) {
      // banks 7e and 7f
      return this.ram[((bank & 0x1) << 16) | adr];
    }
    if(adr < 0x8000 && (bank < 0x40 || (bank >= 0x80 && bank < 0xc0))) {
      // banks 00-3f, 80-bf, $0000-$7fff
      if(adr < 0x2000) {
        return this.ram[adr & 0x1fff];
      }
      if(adr >= 0x2100 && adr < 0x2200) {
        return this.readBBus(adr & 0xff);
      }
      // old-style controller reads
      if(adr === 0x4016) {
        let val = this.joypad1Val & 0x1;
        this.joypad1Val >>= 1;
        this.joypad1Val |= 0x8000;
        return val;
      }
      if(adr === 0x4017) {
        let val = this.joypad2Val & 0x1;
        this.joypad2Val >>= 1;
        this.joypad2Val |= 0x8000;
        return val;
      }
      if(adr >= 0x4200 && adr < 0x4380) {
        return this.readReg(adr);
      }
    }
    return this.cart.read(bank, adr);
  }

  this.read = function(adr, dma = false) {
    if(!dma) {
      this.cpuMemOps++;
      this.cpuCyclesLeft += this.getAccessTime(adr);
    }

    let val = this.rread(adr);
    this.openBus = val;
    return val;
  }

  this.write = function(adr, value, dma = false) {
    if(!dma) {
      this.cpuMemOps++;
      this.cpuCyclesLeft += this.getAccessTime(adr);
    }

    this.openBus = value;
    adr &= 0xffffff;
    //log("Written $" + getByteRep(value) + " to $" + getLongRep(adr));
    let bank = adr >> 16;
    adr &= 0xffff;
    if(bank === 0x7e || bank === 0x7f) {
      // banks 7e and 7f
      this.ram[((bank & 0x1) << 16) | adr] = value;
    }
    if(adr < 0x8000 && (bank < 0x40 || (bank >= 0x80 && bank < 0xc0))) {
      // banks 00-3f, 80-bf, $0000-$7fff
      if(adr < 0x2000) {
        this.ram[adr & 0x1fff] = value;
      }
      if(adr >= 0x2100 && adr < 0x2200) {
        this.writeBBus(adr & 0xff, value);
      }
      if(adr === 0x4016) {
        this.joypadStrobe = (value & 0x1) > 0;
      }
      if(adr >= 0x4200 && adr < 0x4380) {
        this.writeReg(adr, value);
      }

    }
    this.cart.write(bank, adr, value);
  }

  this.getAccessTime = function(adr) {
    adr &= 0xffffff;
    let bank = adr >> 16;
    adr &= 0xffff;
    if(bank >= 0x40 && bank < 0x80) {
      // banks 0x40-0x7f, all slow
      return 8;
    }
    if(bank >= 0xc0) {
      // banks 0xc0-0xff, depends on speed
      return this.fastMem ? 6 : 8;
    }
    // banks 0x00-0x3f and 0x80-0xbf
    if(adr < 0x2000) {
      return 8; // slow
    }
    if(adr < 0x4000) {
      return 6; // fast
    }
    if(adr < 0x4200) {
      return 12; // extra slow
    }
    if(adr < 0x6000) {
      return 6; // fast
    }
    if(adr < 0x8000) {
      return 8; // slow
    }
    // 0x8000-0xffff, depends on fastrom setting if in banks 0x80+
    return (this.fastMem && bank >= 0x80) ? 6 : 8;

  }

  // getting audio and video out, controllers in

  this.setPixels = function(arr) {
    this.ppu.setPixels(arr);
  }

  this.setSamples = function(left, right, samples) {
    this.apu.setSamples(left, right, samples);
  }

  this.setPad1ButtonPressed = function(num) {
    this.joypad1State |= (1 << num);
  }

  this.setPad1ButtonReleased = function(num) {
    this.joypad1State &= (~(1 << num)) & 0xfff;
  }

  // rom loading and header parsing

  this.loadRom = function(rom, isHirom) {
    let header;
    if(rom.length % 0x8000 === 0) {
      // no copier header
      header = this.parseHeader(rom, isHirom);
    } else if((rom.length - 512) % 0x8000 === 0) {
      // 512-byte copier header
      rom = new Uint8Array(Array.prototype.slice.call(rom, 512));
      header = this.parseHeader(rom, isHirom);
    } else {
      log("Failed to load rom: Incorrect size - " + rom.length);
      return false;
    }
    // if(header.type !== 0) {
    //   log("Failed to load rom: not LoRom, type = " + getByteRep(
    //     (header.speed << 4) | header.type
    //   ));
    //   return false;
    // }
    if(rom.length < header.romSize) {
      let extraData = rom.length - (header.romSize / 2);
      log("Extending rom to account for extra data");
      // extend the rom to end up at the correct size
      let nRom = new Uint8Array(header.romSize);
      for(let i = 0; i < nRom.length; i++) {
        if(i < (header.romSize / 2)) {
          nRom[i] = rom[i];
        } else {
          nRom[i] = rom[(header.romSize / 2) + (i % extraData)];
        }
      }
      rom = nRom;
    }
    this.cart = new Cart(rom, header, isHirom);
    return true;
  }

  this.parseHeader = function(rom, isHirom) {
    let str = "";
    let header;
    if(!isHirom) {
      for(let i = 0; i < 21; i++) {
        str += String.fromCharCode(rom[0x7fc0 + i]);
      }
      header = {
        name: str,
        type: rom[0x7fd5] & 0xf,
        speed: rom[0x7fd5] >> 4,
        chips: rom[0x7fd6],
        romSize: 0x400 << rom[0x7fd7],
        ramSize: 0x400 << rom[0x7fd8]
      };
    } else {
      for(let i = 0; i < 21; i++) {
        str += String.fromCharCode(rom[0xffc0 + i]);
      }
      header = {
        name: str,
        type: rom[0xffd5] & 0xf,
        speed: rom[0xffd5] >> 4,
        chips: rom[0xffd6],
        romSize: 0x400 << rom[0xffd7],
        ramSize: 0x400 << rom[0xffd8]
      };
    }
    if(header.romSize < rom.length) {
      // probably wrong header?
      // seems to help with snes test program and such
      let bankCount = Math.pow(2, Math.ceil(Math.log2(rom.length / 0x8000)));
      header.romSize = bankCount * 0x8000;
      log("Loaded with romSize of " + getLongRep(header.romSize));
    }
    return header;
  }

}

export { Snes };
