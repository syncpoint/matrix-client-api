import { randomUUID } from 'node:crypto'

const project = function (matrixAPI, projectId) {
  this.matrixAPI = matrixAPI
  this.projectId = projectId
}

project.prototype.createLayer = async function (name, description, layerId = randomUUID()) {

}

project.prototype.layers = async function () {

}

project.prototype.joinLayer = async function (layerId) {

}

project.prototype.leaveLayer = async function (layerId) {

}

project.prototype.rename = async function (name) {

}

project.prototype.renameLayer = async function renameLayer (name) {

}

project.prototype.post = async function (layerId, message) {

}

project.prototype.startSync = async function (state) {

}

project.prototype.stopSync = async function () {

}

project.prototype.connectionState = function () {
  // online vs. offline
}