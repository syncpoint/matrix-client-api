import { chill } from "../src/convenience.mjs"
import assert from 'assert'

describe('Chill', function () {
  it('Should return on abortion signal', async function () {
    const controller = new AbortController()
    setTimeout((controller) => controller.abort(), 500, controller)
    try {
      await chill(1000, controller.signal)
    } catch (error) {
      assert.equal(error.name, 'AbortError')
    } finally {
      assert.strictEqual(controller.signal.aborted, true)
    }
  })

  it('Should succeed', async function () {
    const controller = new AbortController()
    try {
      await chill(1, controller.signal)
    } catch (error) {
      assert.equal(true, false) // raise an error here
    } finally {
      assert.strictEqual(controller.signal.aborted, false)
    }
  })
})
