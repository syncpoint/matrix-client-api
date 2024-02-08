import assert from 'assert'
import * as power from '../src/powerlevel.mjs'

const ROOM_POWER_LEVEL = 
{
   "users": {
     "@alpha:domain.tld": 100,
     "@beta:domain.tld": 50,
     "@gamma:domain.tld": 0
   },
   "users_default": 0,
   "events": {
     "m.room.name": 50,
     "m.room.power_levels": 100,
     "m.room.history_visibility": 100,
     "m.room.canonical_alias": 50,
     "m.room.avatar": 50,
     "m.room.tombstone": 100,
     "m.room.server_acl": 100,
     "m.room.encryption": 100,
     "m.space.child": 50,
     "m.room.topic": 50,
     "m.room.pinned_events": 50,
     "m.reaction": 0,
     "m.room.redaction": 0,
     "org.matrix.msc3401.call": 50,
     "org.matrix.msc3401.call.member": 50,
     "im.vector.modular.widgets": 50,
     "io.element.voice_broadcast_info": 50
   },
   "events_default": 0,
   "state_default": 50,
   "ban": 50,
   "kick": 50,
   "redact": 50,
   "invite": 0,
   "historical": 100
 }

describe('A role based powerlevel', function () {
    const roomPowerlevel = {
      "users": {
          "@fall:trigonometry.digital": 100,
          "@summer:trigonometry.digital": 50,
          "@spring:trigonometry.digital": 25
      },
      "users_default": 0,
      "events": {
          "m.room.name": 50,
          "m.room.power_levels": 100,
          "io.syncpoint.odin.operation": 25
      },
      "events_default": 100,
      "state_default": 100,
      "ban": 100,
      "kick": 100,
      "redact": 100,
      "invite": 100,
      "historical": 100
    }

    it('should return ADMINISTRATOR', function () {
      const role = power.powerlevel('@fall:trigonometry.digital', roomPowerlevel)
      assert.equal(role.self.name, 'ADMINISTRATOR')
      assert.equal(role.default.name, 'READER')
    })

    it('should return MANAGER', function () {
      const role = power.powerlevel('@summer:trigonometry.digital', roomPowerlevel)
      assert.equal(role.self.name, 'MANAGER')
    })

    it('should return CONTRIBUTOR', function () {
      const role = power.powerlevel('@spring:trigonometry.digital', roomPowerlevel)
      assert.equal(role.self.name, 'CONTRIBUTOR')
    })

    it('should return READER', function () {
      const role = power.powerlevel('@unlisted:trigonometry.digital', roomPowerlevel)
      assert.equal(role.self.name, 'READER')
    })

    it('should return CONTRIBUTOR because of lowered PL for io.syncpoint.odin.operation', function () {
      const collaborativePL = {...roomPowerlevel}
      collaborativePL.events['io.syncpoint.odin.operation'] = roomPowerlevel.users_default
      const role = power.powerlevel('@unlisted:trigonometry.digital', roomPowerlevel)
      assert.equal(role.self.name, 'CONTRIBUTOR')
    })

  })
