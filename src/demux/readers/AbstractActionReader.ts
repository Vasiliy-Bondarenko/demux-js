export default abstract class AbstractActionReader {
  constructor(
    protected startAtBlock: number = 1,
    protected onlyIrreversible: boolean = false,
    protected maxHistoryLength: number = 600,
    public headBlockNumber: number | null = null,
    public currentBlockNumber: number = startAtBlock - 1,
    protected currentBlockData: Block | null = null,
    protected blockHistory: Block[] = [],
  ) {
  }

  /**
   * Loads the head block number, returning an int.
   * If onlyIrreversible is true, return the most recent irreversible block number
   * @return {Promise<number>}
   */
  public abstract async getHeadBlockNumber(): Promise<number>

  /**
   * Loads a block with the given block number
   * @param {number} blockNumber - Number of the block to retrieve
   * @returns {Block}
   */
  public abstract async getBlock(blockNumber: number): Promise<Block>

  /**
   * Loads the next block with chainInterface after validating, updating all relevant state.
   * If block fails validation, rollback will be called, and will update state to last block unseen.
   */
  public async nextBlock(): Promise<[Block | null, boolean, boolean]> {
    let blockData = null
    let rollback = false
    let firstBlock = false

    // If we're on the head block, refresh current head block
    if (this.currentBlockNumber === this.headBlockNumber || !this.headBlockNumber) {
      this.headBlockNumber = await this.getHeadBlockNumber()
    }

    // If currentBlockNumber is negative, it means we wrap to the end of the chain (most recent blocks)
    // This should only ever happen when we first start, so we check that there's no block history
    if (this.currentBlockNumber < 0 && this.blockHistory.length === 0) {
      this.currentBlockNumber = this.headBlockNumber + this.currentBlockNumber
      this.startAtBlock = this.currentBlockNumber + 1
    }

    // If we're now behind one or more new blocks, process them
    if (this.currentBlockNumber < this.headBlockNumber) {
      const unvalidatedBlockData = await this.getBlock(this.currentBlockNumber + 1)
      const expectedHash = this.currentBlockData !== null ? this.currentBlockData.blockHash : "INVALID"
      const actualHash = unvalidatedBlockData.previousBlockHash

      // Continue if the new block is on the same chain as our history, or if we've just started
      if (expectedHash === actualHash || this.blockHistory.length === 0) {
        blockData = unvalidatedBlockData // Block is now validated
        if (this.currentBlockData) {
          this.blockHistory.push(this.currentBlockData) // No longer current, belongs on history
        }
        this.blockHistory.splice(0, this.blockHistory.length - this.maxHistoryLength) // Trim history
        this.currentBlockData = blockData // Replaced with the real current block
        this.currentBlockNumber = this.currentBlockData.blockNumber
      } else {
        // Since the new block did not match our history, we can assume our history is wrong
        // and need to roll back
        await this.rollback()
        blockData = this.currentBlockData
        rollback = true // Signal action handler that we must roll back
        // Reset for safety, as new fork could have less blocks than the previous fork
        this.headBlockNumber = await this.getHeadBlockNumber()
      }
    }

    // Let handler know if this is the earliest block we'll send
    if (this.currentBlockNumber === this.startAtBlock) {
      firstBlock = true
    }

    return [blockData, rollback, firstBlock]
  }

  /**
   * Incrementally rolls back reader state one block at a time, comparing the blockHistory with
   * newly fetched blocks. Rollback is finished when either the current block's previous hash
   * matches the previous block's hash, or when history is exhausted.
   *
   * @return {Promise<void>}
   */
  public async rollback() {
    console.info("!! Fork detected !!")

    let blocksToRewind: number
    // Rewind at least 1 block back
    if (this.blockHistory.length > 0) {
      // TODO:
      // check and throw error if undefined
      const block = this.blockHistory.pop()
      if (block === undefined) {
        throw Error ("block history should not have undefined entries.")
      }
      this.currentBlockData = await this.getBlock(block.blockNumber)
      blocksToRewind = 1
    }

    // Pop off blocks from cached block history and compare them with freshly fetched blocks
    while (this.blockHistory.length > 0) {
      const [cachedPreviousBlockData] = this.blockHistory.slice(-1)
      const previousBlockData = await this.getBlock(cachedPreviousBlockData.blockNumber)
      // TODO:
      // add null guards
      const currentBlock = this.currentBlockData
      if (currentBlock !== null) {
        if (currentBlock.previousBlockHash === previousBlockData.blockHash) {
          console.info(`✓ BLOCK ${currentBlock.blockNumber} MATCH:`)
          console.info(`  expected: ${currentBlock.previousBlockHash}`)
          console.info(`  received: ${previousBlockData.blockHash}`)
          console.info(`Rewinding ${blocksToRewind!} blocks to block (${currentBlock.blockNumber})...`)
          break
        }
        console.info(`✕ BLOCK ${currentBlock.blockNumber} MISMATCH:`)
        console.info(`  expected: ${currentBlock.previousBlockHash}`)
        console.info(`  received: ${previousBlockData.blockHash}`)
        console.info("Rollback history has been exhausted!")
      }

      this.currentBlockData = previousBlockData
      this.blockHistory.pop()
      blocksToRewind! += 1
    }
    if (this.blockHistory.length === 0) {
      await this.rollbackExhausted()
    }
  }

  /**
   * When history is exhausted in rollback(), this is run to handle the situation.
   */
  public rollbackExhausted() {
    throw Error("Rollback history has been exhausted, and no rollback exhaustion handling has been implemented.")
  }

  /**
   * Move to the specified block.
   * @param {number} blockNumber
   * @returns {Promise<void>}
   */
  public async seekToBlock(blockNumber: number): Promise<void> {
    // Clear current block data
    this.currentBlockData = null

    // Check if block exists in history
    let toDelete = -1
    for (const cachedBlockData of this.blockHistory) {
      if (cachedBlockData.blockNumber === blockNumber) {
        break
      } else {
        toDelete += 1
      }
    }
    if (toDelete >= 0) {
      this.blockHistory.splice(this.blockHistory.length - toDelete)
      this.currentBlockData = this.blockHistory.pop() || null
    }

    // Load current block
    this.currentBlockNumber = blockNumber - 1
    if (!this.currentBlockData) {
      this.currentBlockData = await this.getBlock(this.currentBlockNumber)
    }
  }
}
