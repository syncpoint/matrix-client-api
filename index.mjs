import { HttpAPI } from './src/http-api.mjs'
import { StructureAPI } from './src/structure-api.mjs'
import { TimelineAPI } from './src/timeline-api.mjs'
import { CommandAPI } from './src/command-api.mjs'
import { ProjectList } from './src/project-list.mjs'
import { Project } from './src/project.mjs'

const MatrixClient = (loginData) => ({

  projectList: async () => {
    const credentials = await HttpAPI.loginWithPassword(loginData)
    const httpAPI = new HttpAPI(credentials)
    const projectListParames = {
      structureAPI: new StructureAPI(httpAPI),
      timelineAPI: new TimelineAPI(httpAPI)
    }
    return new ProjectList(projectListParames)
  },

  project: async () => {
    const credentials = await HttpAPI.loginWithPassword(loginData)
    const httpAPI = new HttpAPI(credentials)
    const projectParams = {
      structureAPI: new StructureAPI(httpAPI),
      timelineAPI: new TimelineAPI(httpAPI),
      commandAPI: new CommandAPI(httpAPI)
    }
    return new Project(projectParams)
  }
})

export {
  MatrixClient
}