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



describe('Powerlevels', function () {
  describe('an unlisted user', function () {

    const userId = '@delta:domain.tld'

    const actions = [
      { value: power.action.INVITE, expected: true },
      { value: power.action.KICK, expected: false },
      { value: power.action.BAN, expected: false }
    ]

    actions.forEach(({ value, expected }) => {
      it(`can ${expected ? '' : 'not '}"${value}"`, function () {
        const allowed = power.canExecute(userId, value, ROOM_POWER_LEVEL)
        assert.strictEqual(allowed, expected)
      })
    })

  })

  describe('a listed user', function () {

    const userId = '@gamma:domain.tld'

    const actions = [
      { value: power.action.INVITE, expected: true },
      { value: power.action.KICK, expected: false },
      { value: power.action.BAN, expected: false }
    ]

    actions.forEach(({ value, expected }) => {
      it(`can ${expected ? '' : 'not '}"${value}"`, function () {
        const allowed = power.canExecute(userId, value, ROOM_POWER_LEVEL)
        assert.strictEqual(allowed, expected)
      })
    })

  })

  describe('a listed user with PL 50', function () {

    const userId = '@beta:domain.tld'

    const actions = [
      { value: power.action.INVITE, expected: true },
      { value: power.action.KICK, expected: true },
      { value: power.action.BAN, expected: true }
    ]

    actions.forEach(({ value, expected }) => {
      it(`can ${expected ? '' : 'not '}"${value}"`, function () {
        const allowed = power.canExecute(userId, value, ROOM_POWER_LEVEL)
        assert.strictEqual(allowed, expected)
      })
    })

  })

  describe('permissions', function () {
    it('will match', function () {
      const expected = {
        invite: true,
        kick: false,
        ban: false
      }

      const result = power.permissions('@delta:domain.tld', ROOM_POWER_LEVEL)
      assert.deepEqual(result, expected)
    })
  })
  
})