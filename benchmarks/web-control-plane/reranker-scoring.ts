import type { TraceRecord } from './trace-policy-scoring'
import {
  actionFeatures as sharedActionFeatures,
  dot,
  learnedMargin as sharedLearnedMargin,
  tokens,
  trainPerceptron as sharedTrainPerceptron,
  type RerankerActionInput,
} from '../../shared/action-reranker'

export { dot, tokens }

export type RerankerAction = RerankerActionInput & {
  sourceFile: string
  index: number
  status: string
  toolName: string
  selector: string
  text: string | null
  title: string | null
}

export type RerankerCandidate = {
  id: 'candidate_a' | 'candidate_b'
  action: RerankerAction
}

export type RerankerPreferenceRecord = {
  recordType: 'web-control-action-reranker-preference'
  sourceFile: string
  pairIndex: number
  bucket: {
    taskId: string
    toolName: string
  }
  task: TraceRecord['task']
  prompt: string
  candidates: [RerankerCandidate, RerankerCandidate]
  chosen: RerankerCandidate
  rejected: RerankerCandidate
  chosenCompletion: string
  rejectedCompletion: string
}

export function actionFeatures(pair: RerankerPreferenceRecord, action: RerankerAction): Map<string, number> {
  return sharedActionFeatures(pair.task, action)
}

export function trainPerceptron(pairs: RerankerPreferenceRecord[], epochs: number): Map<string, number> {
  return sharedTrainPerceptron(
    pairs.map(pair => ({
      task: pair.task,
      chosen: pair.chosen.action,
      rejected: pair.rejected.action,
    })),
    epochs,
  )
}

export function learnedMargin(pair: RerankerPreferenceRecord, weights: Map<string, number>): { chosenScore: number; rejectedScore: number; margin: number } {
  return sharedLearnedMargin(pair.task, pair.chosen.action, pair.rejected.action, weights)
}
