import { transfer } from 'comlink'
import createSyncTaskQueue from 'sync-task-queue'

import type { Folder, InputMessage, InputFile, DownloadingFile, StreamingFile } from '~/core/store'
import { store } from '~/core/store'
import { getFilePart, getFileMeta, deleteFile, addBytes, transferBytesToFile } from '~/core/cache'
import { api } from '~/api'
import { wait } from '~/tools/wait'
import { generateFileMessageMark } from '~/tools/handle-content'
import { FILE_SIZE, generateFileKey, generateStreamFileUrl, transformToBytes } from '~/tools/handle-file'

import { getActiveFolder } from './folders'
import { getSendingMessage, setSendingMessage, createMessage, refreshMessage } from './messages'

export const uploadFiles = async (
  message: InputMessage,
  folder: Folder,
  parentId: number
) => {
  const { inputFiles = [] } = message

  for (let i = 0; i < inputFiles.length; i++) {
    const sendingMessage = getSendingMessage(folder.id)
    if (!sendingMessage) return

    const inputFile = inputFiles[i]
    const final = i === inputFiles.length - 1

    const uploadedFile = await uploadFile(folder, inputFile)
    if (!uploadedFile) continue

    const success = await createMessage({
      text: generateFileMessageMark(parentId),
      inputMedia: uploadedFile
    }, folder, final)

    if (success && !final) {
      const sendingMessage = getSendingMessage(folder.id)
      if (!sendingMessage) return

      const updatedMessage = {
        ...sendingMessage,
        inputFiles: sendingMessage.inputFiles?.filter(({ fileKey }) => fileKey !== inputFile.fileKey)
      }
      setSendingMessage(folder.id, updatedMessage)
    }
  }

  return message
}

const uploadFile = async (folder: Folder, inputFile: InputFile) => {
  if (!inputFile?.fileKey) return

  const [mainFileParams, thumbFileParams] = await Promise.all([
    inputFile.fileKey, inputFile.thumbFileKey
  ].map(async (fileKey) => {
    if (!fileKey) return

    const isMainFile = fileKey === inputFile.fileKey
    const fileMeta = getFileMeta(fileKey)

    if (!fileMeta || !checkIsUploading(folder, fileKey)) return

    const fileParams = await api.prepareUploadingFile(fileMeta)
    const { partSize, lastPartSize, partsCount } = fileParams

    for (let part = 0; part < partsCount; part++) {
      if (!checkIsUploading(folder, fileKey)) return

      const isLastPart = part === partsCount - 1

      let filePart = getFilePart(fileKey, {
        start: part * partSize,
        end: part * partSize + (isLastPart ? lastPartSize : partSize)
      })

      let filePartBytes = await transformToBytes(filePart) as ArrayBuffer|undefined
      filePart = undefined

      if (!filePartBytes) return

      await api.uploadFilePart(transfer(filePartBytes, [filePartBytes]), {
        ...fileParams,
        part
      })

      filePartBytes = undefined

      if (isMainFile) {
        const progress = Math.round((part + 1) / partsCount * 100)
        onUploadPart(folder, fileKey, progress)
      }
    }

    deleteFile(fileKey)
    return fileParams
  }))

  if (!mainFileParams) return
  const { w, h, duration } = inputFile

  return {
    fileId: mainFileParams.fileId,
    fileName: mainFileParams.fileName,
    fileType: mainFileParams.fileType,
    isLarge: mainFileParams.isLarge,
    partsCount: mainFileParams.partsCount,
    imageParams: (w && h && !duration) ? { w, h } : undefined,
    videoParams: (w && h && duration) ? { w, h, duration } : undefined,
    thumb: thumbFileParams ? {
      fileId: thumbFileParams.fileId,
      fileName: thumbFileParams.fileName,
      fileType: thumbFileParams.fileType,
      isLarge: thumbFileParams.isLarge,
      partsCount: thumbFileParams.partsCount
    } : undefined
  }
}

const checkIsUploading = (folder, fileKey) => {
  const sendingMessage = getSendingMessage(folder.id)
  return !!sendingMessage?.inputFiles?.some(inputFile =>
    [inputFile.fileKey, inputFile.thumbFileKey].includes(fileKey)
  )
}

const onUploadPart = (folder, fileKey, progress) => {
  const sendingMessage = getSendingMessage(folder.id)
  if (!sendingMessage) return

  setSendingMessage(folder.id, {
    ...sendingMessage,
    inputFiles: sendingMessage.inputFiles?.map(inputFile =>
      inputFile.fileKey === fileKey ? ({ ...inputFile, progress }) : inputFile
    )
  })
}

export const resetUploadingFiles = (inputFiles: InputFile[]) => {
  inputFiles.forEach(({ fileKey, thumbFileKey }) => {
    if (fileKey) deleteFile(fileKey)
    if (thumbFileKey) deleteFile(thumbFileKey)
  })
}

export const getDownloadingFile = (file: {
  id: string
  size: number
}) => {
  const fileKey = generateFileKey(file)
  return store.getState().downloadingFiles.get(fileKey)
}

export const setDownloadingFile = (
  file: DownloadingFile
) => {
  const downloadingFiles = new Map(store.getState().downloadingFiles)
  const fileKey = generateFileKey(file)
  downloadingFiles.set(fileKey, file)
  store.setState({
    downloadingFiles
  })
}

export const pauseDownloadingFile = (file: {
  id: string
  size: number
}) => {
  const downloadingFile = getDownloadingFile(file)
  if (downloadingFile?.downloading) {
    setDownloadingFile({
      ...downloadingFile,
      downloading: false
    })
  }
}

export const resetDownloadingFile = (file: {
  id: string
  size: number
}) => {
  const downloadingFiles = new Map(store.getState().downloadingFiles)
  const fileKey = generateFileKey(file)

  if (!downloadingFiles.has(fileKey)) return
  downloadingFiles.delete(fileKey)

  store.setState({
    downloadingFiles
  })
}

const DOWNLOADING_PART_SIZE = FILE_SIZE.KB512
const DOWNLOADING_TIMEOUT = 400
const MAX_DOWNLOADING_COUNT = 4

const downloadingQueue = {
  nextIndex: 0,

  queues: [...Array(MAX_DOWNLOADING_COUNT).keys()].reduce((queue, index) => ({
    ...queue,
    [index]: createSyncTaskQueue()
  }), {}),

  add(fn) {
    const currentIndex = this.nextIndex
    this.queues[currentIndex].enqueue(async () => {
      await fn()
      return wait(DOWNLOADING_TIMEOUT)
    })
    this.nextIndex = currentIndex === MAX_DOWNLOADING_COUNT - 1 ? 0 : currentIndex + 1
  }
}

export const downloadFile = async (
  messageId: number,
  file: DownloadingFile
) => {
  const folder = getActiveFolder() as Folder
  let downloadingFile: DownloadingFile | undefined = getDownloadingFile(file) || file

  if (
    downloadingFile.fileKey ||
    downloadingFile.downloading
  ) return

  downloadingFile = {
    ...downloadingFile,
    file_reference: file.file_reference,
    dc_id: file.dc_id,
    access_hash: file.access_hash,
    sizeType: file.sizeType,
    downloading: true
  }

  if (!downloadingFile.lastPart) {
    const partSize = DOWNLOADING_PART_SIZE
    const partsCount = Math.ceil(file.size / partSize)
    downloadingFile = {
      ...downloadingFile,
      partSize,
      partsCount
    }
  }

  setDownloadingFile(downloadingFile)

  downloadingQueue.add(async () => {
    const downloadingFile = getDownloadingFile(file)
    if (!downloadingFile) return
    const {
      id,
      lastPart = -1,
      partsCount = 0,
      partSize = 0,
      dc_id,
      access_hash,
      file_reference,
      sizeType,
      originalSizeType
    } = downloadingFile

    for (let part = lastPart + 1; part < partsCount; part++ ) {
      let downloadingFile = getDownloadingFile(file)
      if (!downloadingFile || downloadingFile.downloading === false) return

      const offsetSize = part * partSize
      const isLastPart = part === partsCount - 1

      let bytes = await api.downloadFilePart({
        id,
        partSize,
        offsetSize,
        dc_id,
        access_hash,
        file_reference,
        sizeType,
        originalSizeType
      }).catch(({ message }) => {
        if (downloadingFile && message === 'FILE_REFERENCE_EXPIRED') {
          pauseDownloadingFile(downloadingFile)
          refreshMessage(folder, messageId)
        }
      })

      if (!bytes) return

      downloadingFile = getDownloadingFile(file)
      if (!downloadingFile) return

      let fileKey: string|undefined = generateFileKey(downloadingFile)
      const { type } = downloadingFile
      const isImage = type.startsWith('image') || !!sizeType
      const progress = Math.round((part + 1) / partsCount * 100)

      addBytes(fileKey, bytes)
      bytes = undefined

      fileKey = isLastPart ?
        transferBytesToFile(fileKey, isImage ? 'image/jpeg' : type) :
        undefined

      setDownloadingFile({
        ...downloadingFile,
        ...(fileKey ? {
          fileKey,
          downloading: false
        } : {}),
        lastPart: part,
        progress
      })
    }
  })
}

export const getStreamingFile = (
  fileKey: string
) => {
  return store.getState().streamingFiles.get(fileKey)
}

export const setStreamingFile = (
  file: StreamingFile
) => {
  const streamingFiles = new Map(store.getState().streamingFiles)
  const fileKey = generateFileKey(file)
  streamingFiles.set(fileKey, file)
  store.setState({
    streamingFiles
  })
}

export const streamFile = (
  messageId: number,
  file: DownloadingFile
) => {
  const folder = getActiveFolder() as Folder
  const fileKey = generateFileKey(file)
  let streamingFile: StreamingFile | undefined =
    getStreamingFile(fileKey) ||
    { ...file, folder, messageId }

  streamingFile = {
    ...streamingFile,
    file_reference: file.file_reference,
    dc_id: file.dc_id,
    access_hash: file.access_hash,
    streaming: true,
    folder,
    messageId
  }

  setStreamingFile(streamingFile)
  return generateStreamFileUrl(streamingFile)
}

export const downloadStreamFilePart = async ({
  fileKey,
  offsetSize,
  partSize,
  file_reference
}: {
  fileKey: string
  offsetSize: number
  partSize: number
  file_reference?: ArrayBuffer
}): Promise<Uint8Array|undefined> => {
  let streamingFile = getStreamingFile(fileKey) as StreamingFile
  if (!streamingFile) return

  if (file_reference) {
    streamingFile = {
      ...streamingFile,
      file_reference
    }
    setStreamingFile(streamingFile)
  }

  const bytes = await api.downloadFilePart({
    ...streamingFile,
    offsetSize,
    partSize,
    precise: false
  }).catch(({ message }) => {
    if (message === 'FILE_REFERENCE_EXPIRED') {
      const { folder, messageId } = streamingFile
      if (!folder || !messageId) return

      return refreshMessage(folder, messageId, 0, () => {
        const file_reference = getFileReference(streamingFile)
        return downloadStreamFilePart({ fileKey, offsetSize, partSize, file_reference })
      }) as Promise<Uint8Array|undefined>
    }
  })

  return bytes
}

export const getFileReference = ({
  folder,
  messageId,
  id
}: {
  folder: Folder
  messageId: number
  id: string
}) => {
  const state = store.getState()
  const folderMessages = state.foldersMessages.get(folder.id)
  const message = folderMessages?.get(messageId)
  const media = [
    message?.media,
    ...(message?.mediaMessages?.map(({ media }) => media) || [])
  ].find(media => media?.id === id)
  return media?.file_reference
}