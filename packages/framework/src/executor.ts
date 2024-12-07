import s from 'dedent'
import OpenAI from 'openai'
import { zodFunction, zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'

import { Agent } from './agent.js'
import { Message } from './types.js'

const openai = new OpenAI()

import { Workflow } from './workflow.js'

// tbd: add more context like trace, callstack etc. context should be serializable
type ContextOptions = {
  workflow: Workflow
  // tbd: move messages to something such as memory
  messages?: Message[]
}

/**
 * Helper utility to create a context with defaults.
 */
export const context = (options: ContextOptions): Context => {
  return {
    ...options,
    messages: [
      {
        role: 'assistant',
        content: s`
        Here is description of the workflow and expected output by the user:
        <workflow>${options.workflow.description}</workflow>
        <output>${options.workflow.output}</output>
      `,
      },
    ],
  }
}

export type Context = Required<ContextOptions>

// tbd: helper utilities to create contexts from workflows with concrete single task etc.

export async function executeTaskWithAgent(
  agent: Agent,
  messages: Message[],
  team: Agent[]
): Promise<string> {
  {
    const tools = agent.tools
      ? Object.entries(agent.tools).map(([name, tool]) =>
          zodFunction({
            name,
            parameters: tool.parameters,
            function: tool.execute,
            description: tool.description,
          })
        )
      : []

    const response = await openai.beta.chat.completions.parse({
      model: agent.model as string,
      // tbd: verify the prompt
      messages: [
        {
          role: 'system',
          content: s`
                You are ${agent.role}. ${agent.description}
                
                Your job is to complete the assigned task.
                1. You can break down the task into steps
                2. You can use available tools when needed
    
                First try to complete the task on your own.
                Only ask question to the user if you cannot complete the task without their input.
              `,
        },
        ...messages,
      ],
      tools: tools.length > 0 ? tools : undefined,
      response_format: zodResponseFormat(
        z.object({
          response: z.discriminatedUnion('kind', [
            z.object({
              kind: z.literal('step'),
              name: z.string().describe('The name of the step'),
              result: z.string().describe('The result of the step'),
              reasoning: z.string().describe('The reasoning for this step'),
            }),
            z.object({
              kind: z.literal('complete'),
              result: z.string().describe('The final result of the task'),
              reasoning: z.string().describe('The reasoning for completing the task'),
            }),
          ]),
        }),
        'task_result'
      ),
    })
    if (response.choices[0].message.tool_calls.length > 0) {
      const toolResults = await Promise.all(
        response.choices[0].message.tool_calls.map(async (toolCall) => {
          if (toolCall.type !== 'function') {
            throw new Error('Tool call is not a function')
          }

          const tool = agent.tools ? agent.tools[toolCall.function.name] : null
          if (!tool) {
            throw new Error(`Unknown tool: ${toolCall.function.name}`)
          }

          const content = await tool.execute(toolCall.function.parsed_arguments)
          return {
            role: 'tool' as const,
            tool_call_id: toolCall.id,
            content: JSON.stringify(content),
          }
        })
      )

      return executeTaskWithAgent(
        agent,
        [...messages, response.choices[0].message, ...toolResults],
        team
      )
    }

    // tbd: verify shape of response
    const result = response.choices[0].message.parsed
    if (!result) {
      throw new Error('No parsed response received')
    }

    if (result.response.kind === 'step') {
      console.log('🚀 Step:', result.response.name)
      return executeTaskWithAgent(
        agent,
        [
          ...messages,
          {
            role: 'assistant',
            content: result.response.result,
          },
        ],
        team
      )
    }

    if (result.response.kind === 'complete') {
      return result.response.result
    }

    // tbd: check if this is reachable
    throw new Error('Illegal state')
  }
}