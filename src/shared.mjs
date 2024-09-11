/**
 * @readonly
 * @enum {string}
 */
export const ROOM_TYPE = {
  LAYER: {
    type: 'layer',
    fqn: 'io.syncpoint.odin.layer'
  },
  PROJECT: {
    type: 'project',
    fqn: 'm.space'
  },
  WELLKNOWN: {
    EXTENSION: {
      type: 'wellknown+extension',
      fqn: 'io.syncpoint.odin.extension',
      name: 'Extension - A room for bots that extend ODIN'
    }
    // where all the bots assemble in the first place
  }  
}