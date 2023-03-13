# MATRIX Client API

This is a purpose built wrapper for the Matrix API and by no neans a general-purpose SDK! It creates abstractions like `project-list` and `project` which are only suitable for ODINv2 replication.

__WARNING: As of 13mar23 the implementation is limited to the nodejs runtime!__

## http-api
The `http-api` is a very thin layer for the Matrix http (REST-like) api. The only enhancement is the automated renewal of the access token. This API does not have any ODIN domain specific functionality.

On top of the `http-api` we have three pillars (`structure-api`, `command-api` and `timeline-api`). These APIs use ODIN domain terms like _project_ and _layer_ but the __ids used are still out of the Matrix domain__.

## structure-api

The `structure-api` creates ODINv2 structural components like projects (Matrix spaces) and layers (Matrix rooms), allows you to invite users to shared projects and so on. On the other hand one can enumerate existing  projects and invitations to join shared projects. You must be in state `online` to use this API. Top level abstractions must deny access to the methods of this API and/or handle errors accordingly.

## command-api

The `command-api` is a _send-only_ API and is responsible for sending the _payload_ messages to the matrix server. Typically triggered by a state change of a feature or style that is embraced by a _layer_ these messages must get posted in a Matrix room.
This API is the only one that can be used while beeing offline. All messages are queued and delivered in-order. If a client is offline there is a retry mechanism that will even work if ODIN gets shut-down and restarted. (TODO :-))

## timeline-api

The `timeline-api` is a _receive-only_ API and is intended to transfer changes from the matrix server to ODINv2. By making use of filters the API can be focused on the _project list_ or a selected _project_ (making use of room ids).

## project-list

The _project-list_ targets the ODINv2 view where projects are shared and joined. This API requires the _structure-api_ and the _timeline-api_. With the exception of _user-ids_ for invitations only ids from the ODIN domain are visible to users of this API. _project-list_ holds a mapping from ODIN ids to Matrix ids.

## project