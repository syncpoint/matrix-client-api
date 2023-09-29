const action = {
  INVITE: 'invite',
  KICK: 'kick',
  BAN: 'ban',
  REDACT: 'redact'
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

const permissions = function (userId, roomPowerlevels) {
  return Object
            .values(action)
            .reduce(( acc, current ) => {
              acc[current] = canExecute(userId, current, roomPowerlevels)
              return acc
            }, {})
}

export {
  canExecute,
  permissions,
  action
}
