import assert from 'assert'
import { discover, DiscoveryError } from "../src/discover-api.mjs"


describe('Discover', function () {
  it('a matrix server by the user\'s FQMN', async function () {
    const result = await discover({ user_id: '@some.name:syncpoint.io'})
    assert.equal(result.home_server_url, 'https://matrix.syncpoint.io')
  })

  it('a matrix server by the user\'s domain home_server_url', async function () {
    const result = await discover({ home_server_url: 'https://syncpoint.io'})
    assert.equal(result.home_server_url, 'https://matrix.syncpoint.io')
  })

  it('a matrix server by the user\'s FQDN home_server_url', async function () {
    const result = await discover({ home_server_url: 'https://matrix.syncpoint.io'})
    assert.equal(result.home_server_url, 'https://matrix.syncpoint.io')
  })

  it('fail on an invalid hostname', async function () {
    try {
      await discover({ home_server_url: 'https://non-existing.matrix.org'})
    } catch (error) {
      assert.equal(error instanceof DiscoveryError, true)
    }
    
  })

  it('fail on an invalid url', async function () {
    try {
      await discover({ home_server_url: 'https://matrix.org/does-not-exist'})
    } catch (error) {
      assert.equal(error instanceof DiscoveryError, true)
    }
  })


})