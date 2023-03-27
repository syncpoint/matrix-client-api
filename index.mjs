import { HttpAPI } from './src/http-api.mjs'
import { StructureAPI } from './src/structure-api.mjs'
import { TimelineAPI } from './src/timeline-api.mjs'
import { CommandAPI } from './src/command-api.mjs'
import { ProjectList } from './src/project-list.mjs'
import { Project } from './src/project.mjs'

const MatrixClient = (loginData, mostRecentCredentials) => ({

  projectList: async () => {
    
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

  project: async () => {
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
    projectList.tokenRefreshed = handler => httpAPI.tokenRefreshed(handler)
    return project
  }
})

export {
  MatrixClient
}