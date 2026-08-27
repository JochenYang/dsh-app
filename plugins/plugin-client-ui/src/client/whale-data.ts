/**
 * GENERATED FILE — do not edit by hand.
 *
 * DeepSeek whale logo digitile grid, sampled exactly like the upstream
 * HeroDigitileR3F sampler: the white-on-black hero-whale.svg is contain-fit
 * into a 60x60 square canvas (the 24:18 artwork occupies 60x45 cells,
 * letterboxed vertically), cells with luminance > 0.2 become tiles, isolated
 * pixels (no lit cell in the 5x5 neighborhood) are dropped. 1324 tiles total.
 *
 * Payload (base64 → 1774 bytes):
 *   bytes [0, 450)   presence bitmap, row-major, bit = (row*60+col)
 *   bytes [450, 1774)  one byte per lit cell in scan order:
 *     high 4 bits: luminance level 0-15 (coverage → tile opacity)
 *     low 3 bits:  edge factor 0-7 (outside neighbors of 8; drives the loose
 *                  idle drift, stronger at the silhouette rim)
 * Regenerate with scratch/rasterize-whale4.mjs + scratch/emit-whale-data.mjs.
 */
export const WHALE_GRID = 60
export const WHALE_TILE_COUNT = 1324
export const WHALE_DATA_B64 = [
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAA',
  'AAAAOIABAAAAAPgHOAAAAPD/P8ADAADg//8B/AAwgP//H8A/gAP8//8D/Mc/4P//f8B//wP///8P+P8/',
  '+P///4H//8H///9/8P8f/P///w///+D/////4P8H/v///x/8P+D/////h/8A///////4AfCA/////x8A',
  'D8D/////AfAA8P/D/x8ADwD8//n/APAAgP8f/w8AHwDw/+P/APABAP4f/g8AHwDA/8N/APADAPh//AcA',
  'PwAA//8/AOADAOD//wMAfgAA/v8/AOAHAMD//wEA/AAA+P8PAMAfAAD//wAA+AMY8P8HAIB/wAf+PwAA',
  '8A/4wP8DAAD+gT/4HwAAwD/wB/8HAAD4n//g/wEAAP//P/w/AADg/////wMAAPz//8cfAAAA//8/AAAA',
  'AMD//wAAAAAA8P8DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxVRjZJTzRJPj8vHw8qTi8YRkk7PD09PDs5OD0vHw',
  '8PDw8YNE8fDidNPy8fDw8PDw8PDw8PDw8PDw8OJj8PDx8oS0pFTS8fDw8PDw8PDw8PDw8PDw8PDw8NJz',
  '8PDw8PHiZMPx05Px8PDw8PDw8PDw8PDw8PDw8PDw8PDxU2Pw8PDw8PDxZGSDg6Pi8fCzs/Hw8PDw8PDw',
  '8PDw8PDw8PDw8PDw8PDw8XNE8fDw8PDw8NKE8vHw8PDw8PCTo/Hw8PDw8PDw8PDw8PDw8PDw8PDw8PDw',
  '8PDxs+Lw8PDw8PDxwfHw8PDw8PDw8VSD8fDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8dOk8fDw8PDw',
  '8PDw8PDw8PDw8OI08fDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDx4jTy8PDw8PDw8PDw8PDw8PDx',
  'dMLw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw4TR08fDw8PDw8PDw8PDw8PGzRPHw8PDw8PDw',
  '8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8OKT8fDw8PDw8PDw8PDxw7Pw8PDw8PDw8PDw8PDw8PDw8PDw',
  '8PDw8PDw8PDw8PDw8PDx43Px8PDw8PDw8PHylPLw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw',
  '8PDw8eI0svDw8PDx8tOEZPHw8fLTs7PD8/Lx8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDxY+Lw8PDw',
  'opPw8OJ0s/Lx8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8bJDUvHw8PDwg8Pw8NN04vHw8PDw8PDw8PDw',
  '8PDxwnOD0vHw8PDw8PDw8PDw8PDwY+Pw8ON04vHw8PDw8PDw8PDw8YPx8PDw8PDw8PDw8PDxRPPw8POz',
  '8fDw8PDw8PDw8PHSo0Rz8fDw8PDw8PDw8PDy8/Dw8nPx8PDw8PDw8PDwsJDyk/Hw8PDw8PDw8PDT4/Dw',
  '8WRD4fDw8PDw8PDwgGDyNMLw8PDw8PDw8PCT0/Dw8KMz4fDw8PDw8PDw8PE08fDw8PDw8PDxVLPw8PDi',
  'Q/Hw8PDw8PDw8PFjsvDw8PDw8PDik/Dw8PFEY/Hw8PDw8PDw8OFDovDw8PDw8PGUZPHw8PCjk/Hw8PDw',
  '8PDw8PGyo9Lx8PDw8PDw8vLw8PDy0vDw8PDw8PDw8PDw8PDw8PDw8PCzw/Dw8PGUNPHw8PDw8PDw8PDw',
  '8PDw8PDw8PFEdPHw8PDyg/Hw8PDw8PDw8PDw8PDw8PDxo+Lw8PDxw8Px8PDw8PDw8PDw8PDw8PDyhPHw',
  '8PDxc/Lw8PDw8PDw8PDw8PDw8XTi8PDw8PFDdERk8fDw8PDw8PDw8PDw8cNk8fDw8PDhQ0Ty8cJEo/Hw',
  '8PDw8PDw8PDw4rPx8PDw8OFT8vDw8ZPD8fDw8PDw8PDw8VTT8fDw8PDxc5Tx8PDx0jTT8fDw8PDw8PCR',
  '4/Hw8PDw8bPx8PDw8PFj0/Hw8PDw8PDxwmTj8fDw8PDx8pNEc/Hw8PDw8PGjw/Hw8PDw8PDw8eKE0/Hw',
  '8PDw8PDx8vLx8PDw8PDw8PHSZJHw8PDw8PDw8PDxxLPx8PDw8PDw8PDw8PDw8PDw8PDw8fLTs7Ky0sPy',
  '8fDw8PDw8ZRk4vHw8PDw8PDw8PDw8PDw8PDw8PDw8PGzVHODk4NjNJTy8fDw8PDw8PDw8PDw8PDw8PDx',
  '4mSE4vHw8PDw8PDw8PDw8PDx0nREg7PT8/Pz8/Pj06NzNA=='
].join('')
