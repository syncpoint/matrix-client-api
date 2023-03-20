import { FIFO } from '../src/queue.mjs'

const jobs = new FIFO()

Array.from([5, 6, 7, 8, 9, 10, 11]).forEach(m => 
  
  jobs.enqueue(m)
)


for await (const job of jobs) {
  console.log(`Job ${job}`)
  const choice = Math.random()
  if (choice < 0.5) {
    jobs.requeue(job)
  }
}





