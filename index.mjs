import { HttpAPI } from './src/http-api.mjs'
import { StructureAPI } from './src/structure-api.mjs'
import { TimelineAPI } from './src/timeline-api.mjs'
import { CommandAPI } from './src/command-api.mjs'
import { ProjectList } from './src/project-list.mjs'
import { Project } from './src/project.mjs'
import { discover } from './src/discover-api.mjs'
import { chill } from './src/convenience.mjs'

/*
  connect() resolves if the home_server can be connected. It does
  not fail but tries to connect endlessly
*/
const connect = (credentials) => async () => {
  const MAX_CHILL_FACTOR = 64
  let chillFactor = 0
  let connected = false
  while (!connected) {
    await chill(chillFactor)
    try {
      await discover(credentials)
      connected = true
    } catch (error) {
      if (chillFactor < MAX_CHILL_FACTOR) chillFactor++
    }
  } 
}

const MatrixClient = (loginData) => ({

  connect: connect(loginData),

  projectList: async mostRecentCredentials => {
    
    const credentials = mostRecentCredentials ? mostRecentCredentials : (await HttpAPI.loginWithPassword(loginData))
    const httpAPI = new HttpAPI(credentials)
    const projectListParames = {
      structureAPI: new StructureAPI(httpAPI),
      timelineAPI: new TimelineAPI(httpAPI)
    }
    const projectList = new ProjectList(projectListParames)
    projectList.logout = async () => {
      return httpAPI.logout()
    }
    projectList.tokenRefreshed = handler => httpAPI.tokenRefreshed(handler)
    return projectList
  },

  project: async mostRecentCredentials => {
    const credentials = mostRecentCredentials ? mostRecentCredentials : (await HttpAPI.loginWithPassword(loginData))
    const httpAPI = new HttpAPI(credentials)
    const projectParams = {
      structureAPI: new StructureAPI(httpAPI),
      timelineAPI: new TimelineAPI(httpAPI),
      commandAPI: new CommandAPI(httpAPI)
    }
    const project = new Project(projectParams)
    project.logout = async () => {
      return httpAPI.logout()
    }
    project.tokenRefreshed = handler => httpAPI.tokenRefreshed(handler)
    return project
  }
})

export {
  MatrixClient
}