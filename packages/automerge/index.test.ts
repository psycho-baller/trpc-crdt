import { describe, it, expect } from "vitest"
import { initTRPC, TRPCError } from "@trpc/server"
import { z } from "zod"
import { Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"

import { adapter } from "./src/adapter"
import { link } from "./src/link"
import { createTRPCProxyClient, loggerLink, httpBatchLink } from "@trpc/client"
/**
 * Initialization of tRPC backend
 * Should be done only once per backend!
 */
const t = initTRPC.create()
/**
 * Export reusable router and procedure helpers
 * that can be used throughout the router
 */
const router = t.router
const publicProcedure = t.procedure

function initClient() {
  const serverRepo = new Repo({
    network: [new BroadcastChannelNetworkAdapter({ channelName: `trpc-test` })],
  })
  const clientRepo = new Repo({
    network: [new BroadcastChannelNetworkAdapter({ channelName: `trpc-test` })],
  })
  const jobQueueServerHandle = serverRepo.create()
  const jobQueueClientHandle = clientRepo.find(jobQueueServerHandle.url)

  const serverUsersHandle = serverRepo.create()

  // Start adapter
  const appRouter = router({
    userCreate: publicProcedure
      .input(
        z.object({ name: z.string(), optionalDelay: z.number().optional() })
      )
      .mutation(async (opts) => {
        const {
          input,
          ctx: { users, transact, response },
        } = opts
        const user = { id: String(users.length + 1), ...input }

        if (input.optionalDelay) {
          await new Promise((resolve) =>
            setTimeout(resolve, input.optionalDelay)
          )
        }

        if (input.name === `BAD_NAME`) {
          throw new TRPCError({
            code: `CONFLICT`,
            message: `This name isn't one I like to allow`,
          })
        }

        // Run in transaction along with setting response on the request
        // object.
        transact(() => {
          users.push([user])
          response.set(`user`, user)
        })
      }),
    userUpdateName: publicProcedure
      .input(z.object({ id: z.string(), name: z.string() }))
      .mutation(async (opts) => {
        const {
          input,
          ctx: { users, transact, response },
        } = opts
        let user
        let id
        users.forEach((u, i) => {
          if (u.id === input.id) {
            user = u
            id = i
          }
        })
        const newUser = { ...user, name: input.name }

        // Run in transaction along with setting response on the request
        // object.
        transact(() => {
          users.delete(id, 1)
          users.insert(id, [newUser])
          response.set(`user`, newUser)
        })
      }),
  })

  type AppRouter = typeof appRouter
  adapter({
    appRouter,
    context: { queue: jobQueueServerHandle, users: serverUsersHandle },
  })

  // Create client.
  const trpc = createTRPCProxyClient<AppRouter>({
    links: [
      link({
        queue: jobQueueClientHandle,
      }),
    ],
  })

  return { queue: jobQueueClientHandle, trpc }
}

describe(`automerge`, () => {
  describe(`basic calls`, () => {
    const { trpc, queue } = initClient()
    it(`create a user`, async () => {
      const res = await trpc.userCreate.mutate({ name: `foo` })
      expect(res.user.name).toEqual(`foo`)
      const users = doc.getArray(`users`)
      expect(users).toMatchSnapshot()
      expect(users.get(0).name).toEqual(`foo`)
    })
    it(`updateName`, async () => {
      const res = await trpc.userUpdateName.mutate({ id: `1`, name: `foo2` })
      expect(res.user.name).toEqual(`foo2`)
      const users = doc.getArray(`users`)
      expect(users).toMatchSnapshot()
      expect(users.get(0).name).toEqual(`foo2`)
    })
    it(`lets you pass in call id`, async () => {
      const res = await trpc.userCreate.mutate({
        name: `foo`,
        callId: `testing`,
      })
      expect(doc.getArray(`trpc-calls`).toJSON().slice(-1)[0].id).toEqual(
        `testing`
      )
    })
  })
  describe(`batched calls`, () => {
    const { doc, trpc } = initClient()
    it(`handles batched calls`, async () => {
      let promise1
      let promise2
      doc.transact(() => {
        promise1 = trpc.userCreate.mutate({ name: `foo1` })
        promise2 = trpc.userCreate.mutate({ name: `foo2` })
      })

      await Promise.all([promise1, promise2])

      let promise3
      let promise4

      doc.transact(() => {
        promise3 = trpc.userCreate.mutate({ name: `foo3` })
        promise4 = trpc.userCreate.mutate({ name: `foo4` })
      })

      await Promise.all([promise3, promise4])

      await trpc.userCreate.mutate({ name: `foo5` })

      const users = doc.getArray(`users`).toJSON()

      expect(users).toHaveLength(5)
    })
  })
  describe(`out-of-order calls`, async () => {
    const { trpc, doc } = initClient()
    it(`handles out-of-order calls`, async () => {
      const user1Promise = trpc.userCreate.mutate({
        name: `foo1`,
        optionalDelay: 10,
      })
      const user2Promise = trpc.userCreate.mutate({ name: `foo2` })
      const [res1, res2] = await Promise.all([user1Promise, user2Promise])
      expect(res1.user.name).toEqual(`foo1`)
      expect(res2.user.name).toEqual(`foo2`)
    })
  })
  describe(`handle errors`, () => {
    const { trpc } = initClient()
    it(`input errors`, async () => {
      await expect(() =>
        trpc.userCreate.mutate({ name: 1 })
      ).rejects.toThrowError(`invalid_type`)
    })
    it(`router thrown errors`, async () => {
      await expect(() =>
        trpc.userCreate.mutate({ name: `BAD_NAME` })
      ).rejects.toThrowError(`This name isn't one I like to allow`)
    })
  })
})