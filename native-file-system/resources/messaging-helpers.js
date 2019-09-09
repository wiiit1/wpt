'use strict';

// This script depends on the following script:
//    /native-file-system/resources/test-helpers.js

// Adds a message event handler and a message error handler to |receiver|.
// Received message data must include a type property.  The type selects
// the test logic to run.  Most message type handlers use postMessage()
// to respond to the sender with test results.  The sender then validates
// the test results after receiving the response.
//
// Both |target| and |target_origin| are optional.  |target| is used
// to send message responses back to the sender.  When omitted, the
// source property of the message event is used.

// For window messaging, |target_origin| specifies the origin to receive
// responses.  Most window tests use '*' for the |target_origin|.  Worker
// and message port tests must use undefined for |target_origin| to avoid
// exceptions.
function add_message_event_handlers(receiver, target, target_origin) {
  receiver.addEventListener('message', async function (message_event) {
    const message_data = message_event.data;

    // Reply to the sender using the source property of the message event.
    let message_source = message_event.source;
    if (message_source === null) {
      // However, some message senders, like DedicatedWorkers, don't include
      // a source.  Fallback to the target when the source is null.
      message_source = target;
    }

    try {
      switch (message_data.type) {
        case 'receive-message-port':
          // Receive a MessagePort to use as a message target for testing.
          add_message_event_handlers(
            message_data.message_port, message_data.message_port);
          message_data.message_port.start();
          break;

        case 'create-broadcast-channel':
          // Create a BroadcastChannel to use as a message target for testing.
          const broadcast_channel =
            new BroadcastChannel(message_data.broadcast_channel_name);
          add_message_event_handlers(broadcast_channel, broadcast_channel);
          message_source.postMessage(
            { type: 'broadcast-channel-created' }, target_origin);
          break;

        case 'receive-file-system-handles':
          // Receive a list of cloned FileSystemFileHandles.  Respond with the
          // FileSystemFileHandle property values, enabling the sender
          // to verify results.
          const serialized_file_system_handles = [];
          const handles = message_data.file_system_handles;
          for (let i = 0; i < handles.length; ++i) {
            const handle = handles[i];
            const serialized = await serialize_handle(handle);
            serialized_file_system_handles.push({ handle, serialized });
          }
          message_source.postMessage({
            type: 'receive-serialized-file-system-handles',
            serialized_file_system_handles,
          }, target_origin);
          break;

        case 'receive-serialized-file-system-handles':
          // Do nothing.  This message is meant for test runner validation.
          // Message targets may receive this message while testing
          // broadcast channels.
          break;

        case 'create-file':
          // Respond with a FileSystemFileHandle.
          const directory =
            await FileSystemDirectoryHandle.getSystemDirectory(
              { type: 'sandbox' });
          const file_handle =
            await directory.getFile('temp-file', { create: true });
          message_source.postMessage(
            { type: 'receive-file', file_handle }, target_origin);
          break;

        case 'create-directory':
          // Respond with a FileSystemDirectoryHandle.
          const parent_directory =
            await FileSystemDirectoryHandle.getSystemDirectory(
              { type: 'sandbox' });
          const directory_handle =
            await parent_directory.getDirectory('temp-directory',
              { create: true });
          message_source.postMessage(
            { type: 'receive-directory', directory_handle }, target_origin);
          break;

        default:
          throw `Unknown message type: '${message_data.type}'`;
      }
    } catch (error) {
      // Trigger a failure in the sender's test runner.
      message_source.postMessage(`ERROR: ${error}`, target_origin);
    }
  });

  receiver.addEventListener('messageerror', async function (message_event) {
    // Select the target for message responses (see comment in "message" event
    // listener above).
    let message_source = message_event.source;
    if (message_source === null) {
      message_source = target;
    }

    try {
      // Respond with the MessageEvent's property values, enabling the sender
      // to verify results.
      const serialized_message_error_event =
        serialize_message_error_event(message_event);
      message_source.postMessage({
        type: 'serialized-message-error',
        serialized_message_error_event
      }, target_origin);
    } catch (error) {
      // Trigger a failure in the sender's test runner.
      message_source.postMessage(`ERROR: ${error}`, target_origin);
    }
  });
}

// Serializes either a FileSystemFileHandle or FileSystemDirectoryHandle.
async function serialize_handle(handle) {
  let serialized;
  if (handle.isDirectory) {
    serialized = await serialize_file_system_directory_handle(handle);
  } else if (handle.isFile) {
    serialized = await serialize_file_system_file_handle(handle);
  } else {
    throw 'Object is not a FileSystemFileHandle or ' +
    `FileSystemDirectoryHandle ${ handle }`;
  }
  return serialized;
}

// Verifies each property of a serialized FileSystemFileHandle or
// FileSystemDirectoryHandle.
function assert_equals_serialized_handles(left, right) {
  if (left.is_directory) {
    assert_equals_serialized_file_system_directory_handles(left, right);
  } else if (left.is_file) {
    assert_equals_serialized_file_system_file_handles(left, right);
  } else {
    throw 'Object is not a FileSystemFileHandle or ' +
    `FileSystemDirectoryHandle ${handle}`;
  }
}

// Creates a dictionary for a FileSystemHandle base, which contains
// serialized properties shared by both FileSystemFileHandle and
// FileSystemDirectoryHandle.
async function serialize_file_system_handle(file_system_handle) {
  const read_permission =
    await file_system_handle.queryPermission({ writable: false });

  const write_permission =
    await file_system_handle.queryPermission({ writable: true })

  return {
    is_file: file_system_handle.isFile,
    is_directory: file_system_handle.isDirectory,
    name: file_system_handle.name,
    read_permission,
    write_permission
  };
}

// Compares the output of serialize_file_system_handle() for
// two FileSystemHandles.
function assert_equals_serialized_file_system_handles(left, right) {
  assert_equals(left.is_file, right.is_file,
    'Each FileSystemHandle instance must use the expected "isFile".');

  assert_equals(left.is_directory, right.is_directory,
    'Each FileSystemHandle instance must use the expected "isDirectory".');

  assert_equals(left.name, right.name,
    'Each FileSystemHandle instance must use the expected "name" ' +
    ' property.');

  assert_equals(left.read_permission, right.read_permission,
    'Each FileSystemHandle instance must have the expected read ' +
    ' permission.');

  assert_equals(left.write_permission, right.write_permission,
    'Each FileSystemHandle instance must have the expected write ' +
    ' permission.');
}

// Create a dictionary with each property value in FileSystemFileHandle.
// Also, reads the contents of the file to include with the returned
// dictionary.
async function serialize_file_system_file_handle(file_handle) {
  const file_contents = await getFileContents(file_handle);

  const serialized_file_system_handle =
    await serialize_file_system_handle(file_handle);

  return Object.assign(serialized_file_system_handle, { file_contents });
}

// Compares the output of serialize_file_system_file_handle()
// for two FileSystemFileHandle.
function assert_equals_serialized_file_system_file_handles(left, right) {
  assert_equals_serialized_file_system_handles(left, right);
  assert_equals(left.file_contents, right.file_contents,
    'Each FileSystemFileHandle instance must have the same contents.');
}

// Create a dictionary with each property value in FileSystemDirectoryHandle.
async function serialize_file_system_directory_handle(directory_handle) {
  // Serialize the contents of the directory.
  const serialized_files = [];
  const serialized_directories = [];
  for await (const child_handle of directory_handle.getEntries()) {
    const serialized_child_handle = await serialize_handle(child_handle);
    if (child_handle.isDirectory) {
      serialized_directories.push(serialized_child_handle);
    } else {
      serialized_files.push(serialized_child_handle);
    }
  }

  // Order the serialized contents of the directory by name.
  serialized_files.sort((left, right) => {
    return left.name.localeCompare(right.name);
  });
  serialized_directories.sort((left, right) => {
    return left.name.localeCompare(right.name);
  });

  const serialized_file_system_handle =
    await serialize_file_system_handle(directory_handle);

  return Object.assign(
    serialized_file_system_handle,
    { files: serialized_files, directories: serialized_directories });
}

// Compares the output of serialize_file_system_directory_handle()
// for two FileSystemDirectoryHandles.
function assert_equals_serialized_file_system_directory_handles(left, right) {
  assert_equals_serialized_file_system_handles(left, right);

  assert_equals(left.files.length, right.files.length,
    'Each FileSystemDirectoryHandle must contain the same number of ' +
    'file children');

  for (let i = 0; i < left.files.length; ++i) {
    assert_equals_serialized_file_system_file_handles(
      left.files[i], right.files[i]);
  }

  assert_equals(left.directories.length, right.directories.length,
    'Each FileSystemDirectoryHandle must contain the same number of ' +
    'directory children');

  for (let i = 0; i < left.directories.length; ++i) {
    assert_equals_serialized_file_system_directory_handles(
      left.directories[i], right.directories[i]);
  }
}

// Create a dictionary with interesting property values from MessageEvent.
function serialize_message_error_event(message_error_event) {
  return {
    data: message_error_event.data,
    origin: message_error_event.origin,
    last_event_id: message_error_event.lastEventId,
    has_source: (message_error_event.source !== null),
    ports_length: message_error_event.ports.length
  };
}

// Compares the output of serialize_message_error_event() with an
// expected result.
function assert_equals_serialized_message_error_event(
  serialized_event, expected_origin, expected_has_source) {
  assert_equals(serialized_event.data, null,
    'The message error event must set the "data" property to null.');

  assert_equals(serialized_event.origin, expected_origin,
    'The message error event must have the expected "origin" property.');

  assert_equals(serialized_event.last_event_id, "",
    'The message error event must set the "lastEventId" property to the empty string.');

  assert_equals(serialized_event.has_source, expected_has_source,
    'The message error event must have the expected "source" property.');

  assert_equals(serialized_event.ports_length, 0,
    'The message error event not contain any message ports.');
}
