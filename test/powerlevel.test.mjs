import assert from 'assert'
import * as power from '../src/powerlevel.mjs'

describe('A role based powerlevel', function () {

  // Power levels matching ODIN's actual layer configuration
  const roomPowerlevel = {
    'users': {
      '@owner:test': 111,
      '@admin:test': 100,
      '@contributor:test': 25,
      '@reader:test': 0
    },
    'users_default': 0,
    'events': {
      'm.room.name': 25,
      'm.room.power_levels': 100,
      'm.room.history_visibility': 100,
      'm.room.canonical_alias': 100,
      'm.room.avatar': 100,
      'm.room.tombstone': 100,
      'm.room.server_acl': 100,
      'm.room.encryption': 100,
      'm.space.parent': 100,
      'io.syncpoint.odin.operation': 25,
      'm.room.encrypted': 25
    },
    'events_default': 100,
    'state_default': 100,
    'ban': 100,
    'kick': 100,
    'redact': 100,
    'invite': 100,
    'historical': 0
  }

  it('should return OWNER for powerlevel 111', function () {
    const role = power.powerlevel('@owner:test', roomPowerlevel)
    assert.equal(role.self.name, 'OWNER')
    assert.equal(role.self.powerlevel, 111)
    assert.equal(role.default.name, 'READER')
  })

  it('should return OWNER for powerlevel 100 (meets all OWNER event/action requirements)', function () {
    // NOTE: The powerlevel function matches the first role whose event/action
    // requirements are met, iterating from highest to lowest. Since OWNER and
    // ADMINISTRATOR have identical event/action requirements, powerlevel 100
    // matches OWNER. The actual distinction is made via the users map in the
    // power_levels state event — ODIN sets OWNER to 111 explicitly.
    const role = power.powerlevel('@admin:test', roomPowerlevel)
    assert.equal(role.self.name, 'OWNER')
  })

  it('should return CONTRIBUTOR for powerlevel 25', function () {
    const role = power.powerlevel('@contributor:test', roomPowerlevel)
    assert.equal(role.self.name, 'CONTRIBUTOR')
    assert.equal(role.self.powerlevel, 25)
  })

  it('should return READER for powerlevel 0 (default)', function () {
    const role = power.powerlevel('@reader:test', roomPowerlevel)
    assert.equal(role.self.name, 'READER')
    assert.equal(role.self.powerlevel, 0)
  })

  it('should return READER for unlisted user (falls back to users_default)', function () {
    const role = power.powerlevel('@stranger:test', roomPowerlevel)
    assert.equal(role.self.name, 'READER')
  })

  it('should return correct default role from users_default', function () {
    const plWithContributorDefault = {
      ...roomPowerlevel,
      users_default: 25
    }
    const role = power.powerlevel('@stranger:test', plWithContributorDefault)
    assert.equal(role.default.name, 'CONTRIBUTOR')
  })

  it('should include users map in result', function () {
    const role = power.powerlevel('@owner:test', roomPowerlevel)
    assert.ok(role.users)
    assert.equal(role.users['@owner:test'], 111)
    assert.equal(role.users['@admin:test'], 100)
  })

  it('should work with PROJECT scope', function () {
    const projectPowerlevel = {
      ...roomPowerlevel,
      events: {
        'm.room.name': 100,
        'm.room.power_levels': 100,
        'm.space.child': 25
      }
    }
    const role = power.powerlevel('@admin:test', projectPowerlevel, power.SCOPE.PROJECT)
    assert.ok(role, 'should return a role for PROJECT scope')
  })
})
