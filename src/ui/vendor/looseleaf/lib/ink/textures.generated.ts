// PGC: original upstream PNG bytes externalized for caching; no image modification.
import grainTexture0 from './assets/grain-0.png';
import grainTexture1 from './assets/grain-1.png';
import grainTexture2 from './assets/grain-2.png';
import grainTexture3 from './assets/grain-3.png';
import grainTexture4 from './assets/grain-4.png';
export type GrainMaskKind = 'felt' | 'marker' | 'graphite' | 'waxy' | 'stamp'

export interface GrainTile {
  uri: string
  size: number
  density: number
  css: number
  bytes: number
  mean: number
}

export const GRAIN_TILES: Record<GrainMaskKind, GrainTile> = {
  felt: {
    uri: grainTexture0,
    size: 224,
    density: 2,
    css: 112,
    bytes: 14622,
    mean: 0.897,
  },
  marker: {
    uri: grainTexture1,
    size: 256,
    density: 2,
    css: 128,
    bytes: 19041,
    mean: 0.932,
  },
  graphite: {
    uri: grainTexture2,
    size: 224,
    density: 2,
    css: 112,
    bytes: 13207,
    mean: 0.866,
  },
  waxy: {
    uri: grainTexture3,
    size: 224,
    density: 2,
    css: 112,
    bytes: 10023,
    mean: 0.931,
  },
  stamp: {
    uri: grainTexture4,
    size: 320,
    density: 2,
    css: 160,
    bytes: 12359,
    mean: 0.928,
  },
}
