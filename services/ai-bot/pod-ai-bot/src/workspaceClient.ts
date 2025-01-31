//
// Copyright © 2024 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import core, {
  Account,
  Class,
  Client,
  Doc,
  MeasureContext,
  Ref,
  Space,
  Tx,
  TxCreateDoc,
  TxOperations,
  TxProcessor,
  WorkspaceId,
  Blob,
  RateLimiter
} from '@hcengineering/core'
import aiBot, { AIBotEvent, aiBotAccountEmail, AIBotResponseEvent, AIBotTransferEvent } from '@hcengineering/ai-bot'
import chunter, { Channel, ChatMessage, DirectMessage, ThreadMessage } from '@hcengineering/chunter'
import contact, { AvatarType, combineName, getFirstName, getLastName, PersonAccount } from '@hcengineering/contact'
import notification from '@hcengineering/notification'
import { getOrCreateOnboardingChannel } from '@hcengineering/server-analytics-collector-resources'
import { deepEqual } from 'fast-equals'
import { BlobClient } from '@hcengineering/server-client'
import fs from 'fs'
import { WorkspaceInfoRecord } from '@hcengineering/server-ai-bot'

import config from './config'
import { loginBot } from './account'
import { AIBotController } from './controller'
import { connectPlatform } from './platform'

const MAX_LOGIN_DELAY_MS = 15 * 1000 // 15 ses

export class WorkspaceClient {
  client: Client | undefined
  opClient: Promise<TxOperations> | TxOperations

  blobClient: BlobClient

  loginTimeout: NodeJS.Timeout | undefined
  loginDelayMs = 2 * 1000

  channelByKey = new Map<string, Ref<Channel>>()
  aiAccount: PersonAccount | undefined
  rate = new RateLimiter(1)

  directByEmail = new Map<string, Ref<DirectMessage>>()

  constructor (
    readonly transactorUrl: string,
    readonly token: string,
    readonly workspace: WorkspaceId,
    readonly controller: AIBotController,
    readonly ctx: MeasureContext,
    readonly info: WorkspaceInfoRecord | undefined
  ) {
    this.blobClient = new BlobClient(transactorUrl, token, this.workspace)
    this.opClient = this.initClient()
    void this.opClient.then((opClient) => {
      this.opClient = opClient
    })
  }

  private async login (): Promise<string | undefined> {
    this.ctx.info('Logging in: ', this.workspace)
    const token = (await loginBot())?.token

    if (token !== undefined) {
      return token
    } else {
      return (await loginBot())?.token
    }
  }

  private async uploadAvatarFile (client: TxOperations): Promise<void> {
    this.ctx.info('Upload avatar file', { workspace: this.workspace.name })

    try {
      await this.checkPersonData(client)

      const stat = fs.statSync(config.AvatarPath)
      const lastModified = stat.mtime.getTime()

      if (
        this.info !== undefined &&
        this.info.avatarPath === config.AvatarPath &&
        this.info.avatarLastModified === lastModified
      ) {
        this.ctx.info('Avatar file already uploaded', { workspace: this.workspace.name, path: config.AvatarPath })
        return
      }
      const data = fs.readFileSync(config.AvatarPath)

      await this.blobClient.upload(this.ctx, config.AvatarName, data.length, config.AvatarContentType, data)
      await this.controller.updateAvatarInfo(this.workspace, config.AvatarPath, lastModified)
      this.ctx.info('Uploaded avatar file', { workspace: this.workspace.name, path: config.AvatarPath })
    } catch (e) {
      this.ctx.error('Failed to upload avatar file', { e })
    }
  }

  private async tryLogin (): Promise<void> {
    const token = await this.login()

    clearTimeout(this.loginTimeout)

    if (token === undefined) {
      this.loginTimeout = setTimeout(() => {
        if (this.loginDelayMs < MAX_LOGIN_DELAY_MS) {
          this.loginDelayMs += 1000
        }
        this.ctx.info(`login delay ${this.loginDelayMs} millisecond`)
        void this.tryLogin()
      }, this.loginDelayMs)
    }
  }

  private async checkPersonData (client: TxOperations): Promise<void> {
    this.aiAccount = await client.getModel().findOne(contact.class.PersonAccount, { email: aiBotAccountEmail })
    if (this.aiAccount === undefined) {
      this.ctx.error('Cannot find AI PersonAccount', { email: aiBotAccountEmail })
      return
    }
    const person = await client.findOne(contact.class.Person, { _id: this.aiAccount.person })

    if (person === undefined) {
      this.ctx.error('Cannot find AI Person ', { _id: this.aiAccount.person })
      return
    }

    const firstName = getFirstName(person.name)
    const lastName = getLastName(person.name)

    if (lastName !== config.LastName || firstName !== config.FirstName) {
      await client.update(person, {
        name: combineName(config.FirstName, config.LastName)
      })
    }

    if (person.avatar === config.AvatarName) {
      return
    }

    const exist = await this.blobClient.checkFile(this.ctx, config.AvatarName)

    if (!exist) {
      this.ctx.error('Cannot find file', { file: config.AvatarName, workspace: this.workspace.name })
      return
    }

    await client.diffUpdate(person, { avatar: config.AvatarName as Ref<Blob>, avatarType: AvatarType.IMAGE })
  }

  private async initClient (): Promise<TxOperations> {
    await this.tryLogin()

    this.client = await connectPlatform(this.token, this.transactorUrl)
    const opClient = new TxOperations(this.client, aiBot.account.AIBot)

    await this.uploadAvatarFile(opClient)
    const events = await opClient.findAll(aiBot.class.AIBotTransferEvent, {})
    void this.processEvents(events)

    this.client.notify = (...txes: Tx[]) => {
      void this.txHandler(opClient, txes)
    }
    this.ctx.info('Initialized workspace', this.workspace)

    return opClient
  }

  async getThreadParent (
    client: TxOperations,
    event: AIBotTransferEvent,
    _id: Ref<Doc>,
    _class: Ref<Class<Doc>>
  ): Promise<ChatMessage | undefined> {
    const parent = await client.findOne(chunter.class.ChatMessage, {
      attachedTo: _id,
      attachedToClass: _class,
      [aiBot.mixin.TransferredMessage]: {
        messageId: event.parentMessageId,
        parentMessageId: undefined
      }
    })

    if (parent !== undefined) {
      return parent
    }

    return await client.findOne(chunter.class.ChatMessage, {
      _id: event.parentMessageId
    })
  }

  async createTransferMessage (
    client: TxOperations,
    event: AIBotTransferEvent,
    _id: Ref<Doc>,
    _class: Ref<Class<Doc>>,
    space: Ref<Space>,
    message: string
  ): Promise<void> {
    if (event.messageClass === chunter.class.ChatMessage) {
      const ref = await client.addCollection<Doc, ChatMessage>(
        chunter.class.ChatMessage,
        space,
        _id,
        _class,
        event.collection,
        { message }
      )
      await client.createMixin(ref, chunter.class.ChatMessage, space, aiBot.mixin.TransferredMessage, {
        messageId: event.messageId,
        parentMessageId: event.parentMessageId
      })
    } else if (event.messageClass === chunter.class.ThreadMessage && event.parentMessageId !== undefined) {
      const parent = await this.getThreadParent(client, event, _id, _class)

      if (parent !== undefined) {
        const ref = await client.addCollection<Doc, ThreadMessage>(
          chunter.class.ThreadMessage,
          parent.space,
          parent._id,
          parent._class,
          event.collection,
          { message, objectId: parent.attachedTo, objectClass: parent.attachedToClass }
        )
        await client.createMixin(
          ref,
          chunter.class.ThreadMessage as Ref<Class<ChatMessage>>,
          space,
          aiBot.mixin.TransferredMessage,
          {
            messageId: event.messageId,
            parentMessageId: event.parentMessageId
          }
        )
      }
    }
  }

  async processResponseEvent (event: AIBotResponseEvent): Promise<void> {
    const client = await this.opClient

    if (event.messageClass === chunter.class.ChatMessage) {
      await client.addCollection<Doc, ChatMessage>(
        chunter.class.ChatMessage,
        event.objectSpace,
        event.objectId,
        event.objectClass,
        event.collection,
        { message: 'You said: ' + event.message }
      )
    } else if (event.messageClass === chunter.class.ThreadMessage) {
      const parent = await client.findOne<ChatMessage>(chunter.class.ChatMessage, {
        _id: event.objectId as Ref<ChatMessage>
      })

      if (parent !== undefined) {
        await client.addCollection<Doc, ThreadMessage>(
          chunter.class.ThreadMessage,
          event.objectSpace,
          event.objectId,
          event.objectClass,
          event.collection,
          { message: 'You said: ' + event.message, objectId: parent.attachedTo, objectClass: parent.attachedToClass }
        )
      }
    }

    await client.remove(event)
  }

  async processTransferEvent (event: AIBotTransferEvent): Promise<void> {
    const client = await this.opClient

    await this.controller.transfer(event)
    await client.remove(event)
  }

  async getAccount (email: string): Promise<PersonAccount | undefined> {
    const client = await this.opClient

    return await client.findOne(contact.class.PersonAccount, { email })
  }

  async getDirect (email: string): Promise<Ref<DirectMessage> | undefined> {
    const client = await this.opClient

    const personAccount = await this.getAccount(email)

    if (personAccount === undefined) {
      return
    }

    const allAccounts = await client.findAll(contact.class.PersonAccount, { person: personAccount.person })
    const accIds: Ref<Account>[] = [aiBot.account.AIBot, ...allAccounts.map(({ _id }) => _id)].sort()
    const existingDms = await client.findAll(chunter.class.DirectMessage, {})

    for (const dm of existingDms) {
      if (deepEqual(dm.members.sort(), accIds)) {
        return dm._id
      }
    }

    const dmId = await client.createDoc<DirectMessage>(chunter.class.DirectMessage, core.space.Space, {
      name: '',
      description: '',
      private: true,
      archived: false,
      members: accIds
    })

    if (this.aiAccount === undefined) return dmId
    const space = await client.findOne(contact.class.PersonSpace, { person: this.aiAccount.person })
    if (space === undefined) return dmId
    await client.createDoc(notification.class.DocNotifyContext, space._id, {
      user: aiBot.account.AIBot,
      objectId: dmId,
      objectClass: chunter.class.DirectMessage,
      objectSpace: core.space.Space,
      isPinned: false
    })

    return dmId
  }

  async transferToSupport (event: AIBotTransferEvent, channelRef?: Ref<Channel>): Promise<void> {
    const client = await this.opClient
    const key = `${event.toEmail}-${event.fromWorkspace}`
    const channel =
      channelRef ??
      this.channelByKey.get(key) ??
      (
        await getOrCreateOnboardingChannel(this.ctx, client, event.toEmail, {
          workspaceId: event.fromWorkspace,
          workspaceName: event.fromWorkspaceName,
          workspaceUrl: event.fromWorkspaceUrl
        })
      )[0]

    if (channel === undefined) {
      return
    }

    this.channelByKey.set(key, channel)

    await this.createTransferMessage(client, event, channel, chunter.class.Channel, channel, event.message)
  }

  async transferToUserDirect (event: AIBotTransferEvent): Promise<void> {
    const direct = this.directByEmail.get(event.toEmail) ?? (await this.getDirect(event.toEmail))

    if (direct === undefined) {
      return
    }

    this.directByEmail.set(event.toEmail, direct)
    const client = await this.opClient

    await this.createTransferMessage(client, event, direct, chunter.class.DirectMessage, direct, event.message)
  }

  getChannelRef (email: string, workspace: string): Ref<Channel> | undefined {
    const key = `${email}-${workspace}`

    return this.channelByKey.get(key)
  }

  async transfer (event: AIBotTransferEvent): Promise<void> {
    if (event.toWorkspace === config.SupportWorkspace) {
      const channel = this.getChannelRef(event.toEmail, event.fromWorkspace)

      if (channel !== undefined) {
        await this.transferToSupport(event, channel)
      } else {
        // If we dont have OnboardingChannel we should call it sync to prevent multiple channel for the same user and workspace
        await this.rate.add(async () => {
          await this.transferToSupport(event)
        })
      }
    } else {
      if (this.directByEmail.has(event.toEmail)) {
        await this.transferToUserDirect(event)
      } else {
        // If we dont have Direct with user we should call it sync to prevent multiple directs for the same user
        await this.rate.add(async () => {
          await this.transferToUserDirect(event)
        })
      }
    }
  }

  async processEvents (events: AIBotEvent[]): Promise<void> {
    if (events.length === 0 || this.opClient === undefined) {
      return
    }

    for (const event of events) {
      try {
        if (event._class === aiBot.class.AIBotResponseEvent) {
          void this.processResponseEvent(event as AIBotResponseEvent)
        } else if (event._class === aiBot.class.AIBotTransferEvent) {
          void this.processTransferEvent(event as AIBotTransferEvent)
        }
      } catch (e) {
        this.ctx.error('Error processing event: ', { e })
      }
    }
  }

  async close (): Promise<void> {
    clearTimeout(this.loginTimeout)

    if (this.client !== undefined) {
      await this.client.close()
    }

    if (this.opClient instanceof Promise) {
      void this.opClient.then((opClient) => {
        void opClient.close()
      })
    } else {
      await this.opClient.close()
    }

    this.ctx.info('Closed workspace client: ', this.workspace)
  }

  private async txHandler (client: TxOperations, txes: Tx[]): Promise<void> {
    const hierarchy = client.getHierarchy()

    const resultTxes = txes
      .map((a) => TxProcessor.extractTx(a) as TxCreateDoc<AIBotEvent>)
      .filter(
        (tx) => tx._class === core.class.TxCreateDoc && hierarchy.isDerived(tx.objectClass, aiBot.class.AIBotEvent)
      )
      .map((tx) => TxProcessor.createDoc2Doc(tx))

    await this.processEvents(resultTxes)
  }
}
