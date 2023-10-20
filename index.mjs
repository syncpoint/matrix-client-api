import { HttpAPI } from './src/http-api.mjs'
import { StructureAPI } from './src/structure-api.mjs'
import { TimelineAPI } from './src/timeline-api.mjs'
import { CommandAPI } from './src/command-api.mjs'
import { ProjectList } from './src/project-list.mjs'
import { Project } from './src/project.mjs'
import { discover, errors } from './src/discover-api.mjs'
import { chill } from './src/convenience.mjs'

/*
  connect() resolves if the home_server can be connected. It does
  not fail but tries to connect endlessly
*/
const connect = (home_server_url) => async () => {
  const MAX_CHILL_FACTOR = 64
  let chillFactor = 0
  let connected = false
  while (!connected) {
    await chill(chillFactor)
    try {
      await discover({ home_server_url })
      connected = true
    } catch (error) {
      if (error.code === errors.FAIL_PROMPT) {
        connected = true
        continue
      }
      if (chillFactor < MAX_CHILL_FACTOR) chillFactor++
    }
  } 
}

/**
 * @typedef {Object} LoginData
 * @property {String} user_id
 * @property {String} password
 * @property {String} home_server_url
 * 
 * @param {LoginData} loginData 
 * @returns {Object} matrixClient
 */
const MatrixClient = (loginData) => ({

  connect: connect(loginData.home_server_url),
  
  projectList: async mostRecentCredentials => {
    
    const credentials = mostRecentCredentials ? mostRecentCredentials : (await HttpAPI.loginWithPassword(loginData))
    const httpAPI = new HttpAPI(credentials)
    const projectListParames = {
      structureAPI: new StructureAPI(httpAPI),
      timelineAPI: new TimelineAPI(httpAPI)
    }
    const projectList = new ProjectList(projectListParames)
    projectList.tokenRefreshed = handler => httpAPI.tokenRefreshed(handler)
    projectList.credentials = () => (httpAPI.credentials)
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
    project.tokenRefreshed = handler => httpAPI.tokenRefreshed(handler)
    project.credentials = () => (httpAPI.credentials)
    return project
  }
})

export {
  MatrixClient,
  discover
}