
const ODINv2_MESSAGE_TYPE = 'io.syncpoint.odin.operation'

const SCOPE = {
  LAYER: 'LAYER',
  PROJECT: 'PROJECT'
}

// ordered by the power of the role (desc)
const ROLES = {
  LAYER: 
    {
      'ADMINISTRATOR': {
        name: 'ADMINISTRATOR',
        powerlevel: 100,
        events: ['m.room.name', 'm.room.power_levels', ODINv2_MESSAGE_TYPE],
        actions: ['kick', 'ban', 'redact']
      },
      'MANAGER':
      {
        name: 'MANAGER',
        powerlevel: 50,
        events: ['m.room.name', ODINv2_MESSAGE_TYPE],
        actions: [],
      },
      'CONTRIBUTOR': {
        name: 'CONTRIBUTOR',
        powerlevel: 25,
        events: [ODINv2_MESSAGE_TYPE],
        actions: []
      },
      'READER':
      {
        name: 'READER',
        powerlevel: 0,
        events: [],
        actions: []
      }
    },
  PROJECT: {
    'ADMINISTRATOR': {
      name: 'ADMINISTRATOR',
      powerlevel: 100,
      events: ['m.room.name', 'm.room.power_levels', 'm.space.child'],
      actions: ['kick', 'ban', 'redact', 'invite']
    },
    'MANAGER': {
      name: 'MANAGER',
      powerlevel: 50,
      events: ['m.room.name', 'm.space.child'],
      actions: ['kick', 'ban', 'invite'],
    },
    'CONTRIBUTOR': {
      name: 'CONTRIBUTOR',
      powerlevel: 25,
      events: ['m.space.child'],
      actions: []
    },
    'READER': {
      name: 'READER',
      powerlevel: 0,
      events: [],
      actions: []
    }
  }
}

Object.freeze(ROLES)



const powerlevel = function (userId, roomPowerlevels, scope = SCOPE.LAYER) {
  const assignedLevel = (roomPowerlevels.users && roomPowerlevels.users[userId] !== undefined)
    ? roomPowerlevels.users[userId]
    : roomPowerlevels.users_default

  for (const r of Object.values(ROLES[scope])) {
    const events = r.events.reduce((accu, current) => {
      return (accu && (assignedLevel >= roomPowerlevels.events[current]))
    }, true)
    const actions = r.actions.reduce((accu, current) => {
      return (accu && (assignedLevel >= roomPowerlevels[current]))
    }, true)

    if (events && actions) return r
  }
}

const canExecute = function (userId, action, roomPowerlevels) {

  const levelRequired = roomPowerlevels[action] !== undefined
    ? roomPowerlevels[action] 
    : roomPowerlevels.state_default

  const levelAssigned = (roomPowerlevels.users && roomPowerlevels.users[userId] !== undefined)
    ? roomPowerlevels.users[userId]
    : roomPowerlevels.users_default

  return (levelAssigned >= levelRequired)
}

export {
  powerlevel,
  ROLES,
  SCOPE
}
