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
    ASSEMBLY: {
      type: 'wellknown+assembly',
      fqn: 'io.syncpoint.odin.assembly',
      name: 'Assembly - Where all the bots assemble'
    }
    // where all the bots assemble in the first place
  }  
}