import { FIFO } from '../src/queue.mjs'

const jobs = new FIFO()

/* Array.from([5,6,7,8,9,15]).forEach(m => {
  setTimeout(() => { jobs.enqueue(async () => console.log(`Job ${m}`))}, m * 2_000)
}) */

let requeued = false

const doTheWork = async () => {
  const job = await jobs.dequeue()
  try {
    await job()
    setImmediate(doTheWork)
  } catch (error) {
    console.dir(error)
    jobs.requeue(job)
    setTimeout(doTheWork,10_000)
  }
}

doTheWork().then(() => console.log('Hä??'))