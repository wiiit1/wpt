// META: script=/common/get-host-info.sub.js
// META: script=/service-workers/service-worker/resources/test-helpers.sub.js
// META: script=resources/test-helpers.js
// META: script=resources/messaging-helpers.js
'use strict';

// This file tests sending and receiving FileSystemHandles through postMessage.
// This includes both FileSystemFileHandle and FileSystemDirectoryHandle.
// Sending these objects cross origin must dispatch a "messageerror" event.

// Define the URL constants used for each type of message target, including
// iframes, workers, etc...
const kDocumentMessageTarget = 'resources/message-target.html';
const kSharedWorkerMessageTarget = 'resources/message-target-shared-worker.js';
const kServiceWorkerMessageTarget =
  'resources/message-target-service-worker.js';
const kDedicatedWorkerMessageTarget =
  'resources/message-target-dedicated-worker.js';
const kRemoteOrigin = get_host_info().HTTPS_REMOTE_ORIGIN;
const kRemoteOriginDocumentMessageTarget = `${kRemoteOrigin}${base_path()}` +
  kDocumentMessageTarget;

// Creates an iframe and waits to receive a message from the iframe.
// Valid |options| include src, srdoc and sandbox, which mirror the
// corresponding iframe element properties.
async function add_iframe(test, options) {
  const iframe = document.createElement('iframe');

  if (options.sandbox !== undefined) {
    iframe.sandbox = options.sandbox;
  }

  if (options.src !== undefined) {
    iframe.src = options.src;
  }

  if (options.srcdoc !== undefined) {
    iframe.srcdoc = options.srcdoc;
  }

  document.body.appendChild(iframe);
  test.add_cleanup(() => {
    iframe.remove();
  });

  await wait_for_loaded_message(self);
  return iframe;
}

// Creates a child window using window.open() and waits to receive a message
// from the child window.
async function open_window(test, url) {
  const child_window = window.open(url);
  test.add_cleanup(() => {
    child_window.close();
  });
  await wait_for_loaded_message(self);
  return child_window;
}

function create_dedicated_worker(test, url) {
  const dedicated_worker = new Worker(url);
  test.add_cleanup(() => {
    dedicated_worker.terminate();
  });
  return dedicated_worker;
}

// Wait until |receiver| gets a message event with the data set to 'LOADED'.
// This test file uses messaging instead of the loaded event because
// cross-origin child windows from window.open() do not dispatch the loaded
// event to the parent window.
async function wait_for_loaded_message(receiver) {
  const message_promise = new Promise((resolve, reject) => {
    receiver.addEventListener('message', message_event => {
      if (message_event.data === 'LOADED') {
        resolve();
      } else {
        reject('The message target must receive a "LOADED" message response.');
      }
    });
  });
  await message_promise;
}

// Sets up a new message channel.  Sends one port to |target| and then returns
// the other port.
function create_message_channel(target, target_origin) {
  const message_channel = new MessageChannel();

  const message_data =
    { type: 'receive-message-port', message_port: message_channel.port2 };

  if (target_origin !== undefined) {
    target.postMessage(message_data, target_origin, [message_channel.port2]);
  } else {
    target.postMessage(message_data, [message_channel.port2]);
  }
  message_channel.port1.start();
  return message_channel.port1;
}

// Sets up a new broadcast channel in |target|.  Posts a message instructing
// |target| to open the broadcast channel using |broadcast_channel_name|.
async function create_broadcast_channel(
  test, broadcast_channel_name, receiver, target, target_origin) {
  target.postMessage(
    { type: 'create-broadcast-channel', broadcast_channel_name },
    target_origin);
  const event_watcher = new EventWatcher(test, receiver, 'message');

  // Wait until |target| is listening to the broad cast channel.
  const message_event = await event_watcher.wait_for('message');
  assert_equals(message_event.data.type, 'broadcast-channel-created',
    'The message target must receive a "broadcast-channel-created" message ' +
    'response.');
}

// Sends a 'receive-file-system-handles' message to the target.
function send_file_system_handles(handles, target, target_origin) {
  target.postMessage(
    { type: 'receive-file-system-handles', file_system_handles: handles },
    target_origin);
}

// Creates a variety of different FileSystemFileHandles for testing.
// Then sends an array of FileSystemFileHandles to |target|.
// Returns the array of FileSystemFileHandles after sending it to |target|.
async function create_and_send_file_system_handles(
  test, target, target_origin) {
  // Create some files to send.
  const empty_file = await createEmptyFile(test, 'empty-file');
  const first_file = await createFileWithContents(
    test, 'first-file-with-contents', 'first-text-content');
  const second_file = await createFileWithContents(
    test, 'second-file-with-contents', 'second-text-content');

  // Create an empty directory to send.
  const empty_directory = await createDirectory(test, 'empty-directory');

  // Create a directory containing both files and subdirectories to send.
  const directory_with_files =
    await createDirectory(test, 'directory-with-files');
  await createFileWithContents(test, 'first-file-in-directory',
    'first-directory-text-content', directory_with_files);
  await createFileWithContents(test, 'second-file-in-directory',
    'second-directory-text-content', directory_with_files);
  const subdirectory =
    await createDirectory(test, 'subdirectory', directory_with_files);
  await createFileWithContents(test, 'first-file-in-subdirectory',
    'first-subdirectory-text-content', subdirectory);

  const file_system_handles = [
    empty_file,
    first_file,
    second_file,
    // Clone the same FileSystemFileHandle object twice.
    second_file,
    empty_directory,
    // Clone the smae FileSystemDirectoryHandle object twice.
    empty_directory,
    directory_with_files
  ];
  send_file_system_handles(file_system_handles, target, target_origin);
  return file_system_handles;
}

// Verifies the response to 'receive-file-system-handles' messages.
// The response contains two parts:
//
// (1) The same list of file handles that the test previous sent.
//     This enables the test to verify that the message target could
//     send messages containing FileSystemHandles.
//
// (2) The serialized list of files.  This verifies that the message
//     target could access the files it received through postMessage().
async function verify_response_with_file_system_handles(
  response, expected_handles) {
  assert_equals(response.type, 'receive-serialized-file-system-handles',
    'The message target must receive a "serialized-file-system-handles" ' +
    `message response. Actual response: ${response}`);

  const response_handles = response.serialized_file_system_handles;
  assert_equals(response_handles.length, expected_handles.length,
    'The response must include the expected number of serialized ' +
    'FileSystemHandles.');

  // Verify the properties of each FileSystemHandle sent through postMessage().
  for (let i = 0; i < expected_handles.length; ++i) {
    const response_handle = response_handles[i];
    const expected_handle = expected_handles[i];

    const cloned_handle = response_handle.handle;
    assert_not_equals(cloned_handle, expected_handle,
      'Cloning a FileSystemFileHandle through postMessage() must create ' +
      'a new instance.');

    const serialized_cloned_handle =
      await serialize_handle(cloned_handle);

    const expected_serialized_file_handle =
      await serialize_handle(expected_handle);

    // Verify the message target successfully sent FileSystemHandles
    // through postMessage().
    assert_equals_serialized_handles(
      serialized_cloned_handle, expected_serialized_file_handle);

    // Verify the message target successfully accessed the FileSystemHandles
    // received through post message.
    assert_equals_serialized_handles(
      response_handle.serialized, expected_serialized_file_handle);
  }
}

// If the message target receives a "messageerror" event, it responds with a
// 'serialized-message-error', which enables the test to validate the
// MessageEvent properties for the "messageerror".
function verify_response_with_message_error(
  response, expected_origin, expected_has_source) {
  assert_equals(response.type, 'serialized-message-error',
    'The message target must receive a "serialized-message-error" message ' +
    'response.');

  assert_equals_serialized_message_error_event(
    response.serialized_message_error_event,
    expected_origin, expected_has_source);
}

// Sends an array of FileSystemFileHandles to |target| and then verifies the
// response.
async function do_post_message_test(test, receiver, target, target_origin) {
  const file_system_handles =
    await create_and_send_file_system_handles(test, target, target_origin);

  const event_watcher = new EventWatcher(test, receiver, 'message');
  const message_event = await event_watcher.wait_for('message');

  await verify_response_with_file_system_handles(
    message_event.data, file_system_handles);
}

// Send a message port to |target|.  Then sends an array of
// FileSystemFileHandles through the message port and verifies
// the response.
async function do_message_port_test(test, target, target_origin) {
  const message_port = create_message_channel(target, target_origin);
  await do_post_message_test(test, message_port, message_port);
}

// Verifies the cross origin target and this test page cannot send
// FileSystemHandles to each other.
async function do_message_error_test(
  test,
  receiver,
  target,
  target_origin,
  expected_has_source, // False when the MessageEvent's source is null.
  expected_origin, // The origin of the MessageEvent sent by this test page.
  expected_remote_origin) { // The origin of the event sent by the remote page.
  const message_watcher = new EventWatcher(test, receiver, 'message');
  const error_watcher = new EventWatcher(test, receiver, 'messageerror');

  // Send a file to |target|.
  const file = await createFileWithContents(
    test, 'test-error-file', 'test-error-file-contents');
  send_file_system_handles([file], target, target_origin);
  const first_response = await message_watcher.wait_for('message');
  verify_response_with_message_error(
    first_response.data, expected_origin, expected_has_source);

  // Send a directory to |target|.
  const directory = await createDirectory(test, 'test-error-directory');
  send_file_system_handles([directory], target, target_origin);
  const second_response = await message_watcher.wait_for('message');
  verify_response_with_message_error(
    second_response.data, expected_origin, expected_has_source);

  // Receive a file from |target|.
  target.postMessage({ type: 'create-file' }, target_origin);
  const first_error = await error_watcher.wait_for('messageerror');
  const serialized_first_error = serialize_message_error_event(first_error);
  assert_equals_serialized_message_error_event(
    serialized_first_error, expected_remote_origin, expected_has_source);

  // Receive a directory from |target|.
  target.postMessage({ type: 'create-directory' }, target_origin);
  const second_error = await error_watcher.wait_for('messageerror');
  const serialized_second_error = serialize_message_error_event(second_error);
  assert_equals_serialized_message_error_event(
    serialized_second_error, expected_remote_origin, expected_has_source);
}

// Same as do_message_error_test(), but uses a message port.
async function do_message_port_error_test(test, target, target_origin) {
  const message_port = create_message_channel(target, target_origin);
  await do_message_error_test(
    test, message_port, message_port, undefined,
    /*expected_has_source=*/false, /*expected_origin=*/'',
    /*expected_remote_origin=*/'');
}

async function fetch_text(url) {
  const response = await fetch(url);
  return await response.text();
}

// Constructs a version of 'message-target.html' without any subresources.
// Enables blobs and data URI windows to load message-target.html.
async function create_message_target_html_without_subresources(test) {
  const test_helpers_script = await fetch_text('resources/test-helpers.js');

  const messaging_helpers_script =
    await fetch_text('resources/messaging-helpers.js');

  const iframe = await add_iframe(test, { src: kDocumentMessageTarget });
  const iframe_script =
    iframe.contentWindow.document.getElementById('inline_script').outerHTML;
  iframe.remove();

  return '<!DOCTYPE html>' +
    `<script>${test_helpers_script}</script>` +
    `<script>${messaging_helpers_script}</script>` +
    `${iframe_script}`;
}

// Creates a blob URL for message-target.html.
async function create_message_target_blob_url(test) {
  const html = await create_message_target_html_without_subresources(test);
  const blob = new Blob([html], { type: 'text/html' });
  return URL.createObjectURL(blob);
}

// Creates a data URI for message-target.html.
async function create_message_target_data_uri(test) {
  const iframe_html =
    await create_message_target_html_without_subresources(test);
  return `data:text/html,${encodeURIComponent(iframe_html)}`;
}

promise_test(async t => cleanupSandboxedFileSystem(),
  'Cleanup to setup test environment');

promise_test(async t => {
  const iframe = await add_iframe(t, { src: kDocumentMessageTarget });
  await do_post_message_test(t, self, iframe.contentWindow, '*');
}, 'Send and receive messages using a same origin iframe.');

promise_test(async t => {
  const iframe = await add_iframe(t, { src: kDocumentMessageTarget });
  await do_message_port_test(t, iframe.contentWindow, '*');
}, 'Send and receive messages using a message port in a same origin ' +
  'iframe.');

promise_test(async t => {
  const iframe = await add_iframe(t, {
    src: kDocumentMessageTarget,
    sandbox: 'allow-scripts allow-same-origin'
  });
  await do_post_message_test(t, self, iframe.contentWindow, '*');
}, 'Send and receive messages using a sandboxed same origin iframe.');

promise_test(async t => {
  const iframe = await add_iframe(t, {
    src: kDocumentMessageTarget,
    sandbox: 'allow-scripts allow-same-origin'
  });
  await do_message_port_test(t, iframe.contentWindow, '*');
}, 'Send and receive messages using a message port in a sandboxed same ' +
  'origin iframe.');

promise_test(async t => {
  const blob_url = await create_message_target_blob_url(t);
  const iframe = await add_iframe(t, { src: blob_url });
  await do_post_message_test(t, self, iframe.contentWindow, '*');
}, 'Send and receive messages using a blob iframe.');

promise_test(async t => {
  const blob_url = await create_message_target_blob_url(t);
  const iframe = await add_iframe(t, { src: blob_url });
  await do_message_port_test(t, iframe.contentWindow, '*');
}, 'Send and receive messages using a message port in a blob iframe.');

promise_test(async t => {
  const iframe_html = await create_message_target_html_without_subresources(t);
  const iframe = await add_iframe(t, { srcdoc: iframe_html });
  await do_post_message_test(t, self, iframe.contentWindow, '*');
}, 'Send and receive messages using an iframe srcdoc.');

promise_test(async t => {
  const iframe_html = await create_message_target_html_without_subresources(t);
  const iframe = await add_iframe(t, { srcdoc: iframe_html });
  await do_message_port_test(t, iframe.contentWindow, '*');
}, 'Send and receive messages using a message port in an iframe srcdoc.');

promise_test(async t => {
  const child_window = await open_window(t, kDocumentMessageTarget);
  await do_post_message_test(t, self, child_window, '*');
}, 'Send and receive messages using a same origin window.');

promise_test(async t => {
  const child_window = await open_window(t, kDocumentMessageTarget);
  await do_message_port_test(t, child_window, '*');
}, 'Send and receive messages using a message port in a same origin ' +
  'window.');

promise_test(async t => {
  const blob_url = await create_message_target_blob_url(t);
  const child_window = await open_window(t, blob_url);
  await do_post_message_test(t, self, child_window, '*');
}, 'Send and receive messages using a blob window.');

promise_test(async t => {
  const blob_url = await create_message_target_blob_url(t);
  const child_window = await open_window(t, blob_url);
  await do_message_port_test(t, child_window, '*');
}, 'Send and receive messages using a message port in a blob window.');

promise_test(async t => {
  const url = `${kDocumentMessageTarget}?pipe=header(Content-Security-Policy` +
    ', sandbox allow-scripts allow-same-origin)';
  const child_window = await open_window(t, url);
  await do_post_message_test(t, self, child_window, '*');
}, 'Send and receive messages using a sandboxed same origin window.');

promise_test(async t => {
  const url = `${kDocumentMessageTarget}?pipe=header(Content-Security-Policy` +
    ', sandbox allow-scripts allow-same-origin)';
  const child_window = await open_window(t, url);
  await do_message_port_test(t, child_window, '*');
}, 'Send and receive messages using a message port in a sandboxed same ' +
  'origin window.');

promise_test(async t => {
  const dedicated_worker =
    create_dedicated_worker(t, kDedicatedWorkerMessageTarget);
  await do_post_message_test(t, dedicated_worker, dedicated_worker);
}, 'Send and receive messages using a dedicated worker.');

promise_test(async t => {
  const dedicated_worker =
    create_dedicated_worker(t, kDedicatedWorkerMessageTarget);
  await do_message_port_test(t, dedicated_worker);
}, 'Send and receive messages using a message port in a dedicated ' +
  'worker.');

promise_test(async t => {
  const scope = `${kServiceWorkerMessageTarget}?post-message-with-file-handle`;
  const registration = await service_worker_unregister_and_register(
    t, kServiceWorkerMessageTarget, scope);
  await do_post_message_test(
    t, navigator.serviceWorker, registration.installing);
}, 'Send and receive messages using a service worker.');

promise_test(async t => {
  const scope = `${kServiceWorkerMessageTarget}` +
    '?post-message-to-message-port-with-file-handle';
  const registration = await service_worker_unregister_and_register(
    t, kServiceWorkerMessageTarget, scope);
  await do_message_port_test(t, registration.installing);
}, 'Send and receive messages using a message port in a service ' +
  'worker.');

if (self.SharedWorker !== undefined) {
  promise_test(async t => {
    const shared_worker = new SharedWorker(kSharedWorkerMessageTarget);
    shared_worker.port.start();
    await do_post_message_test(t, shared_worker.port, shared_worker.port);
  }, 'Send and receive messages using a shared worker.');

  promise_test(async t => {
    const shared_worker = new SharedWorker(kSharedWorkerMessageTarget);
    shared_worker.port.start();
    await do_message_port_test(t, shared_worker.port);
  }, 'Send and receive messages using a message port in a shared ' +
    ' worker.');
}

promise_test(async t => {
  const iframe = await add_iframe(
    t, { src: kRemoteOriginDocumentMessageTarget });
  await do_message_error_test(
    t, self, iframe.contentWindow, '*',
    /*expected_has_source*/true, location.origin, kRemoteOrigin);
}, 'Fail to send and receive messages using a cross origin iframe.');

promise_test(async t => {
  const iframe = await add_iframe(t, { src: kRemoteOriginDocumentMessageTarget });
  await do_message_port_error_test(t, iframe.contentWindow, '*');
}, 'Fail to send and receive messages using a cross origin message port in ' +
  'an iframe.');

//promise_test(async t => {
//  const iframe = await add_iframe(
//    t, { src: kDocumentMessageTarget, sandbox: 'allow-scripts' });
//  await do_message_error_test(
//    t, self, iframe.contentWindow, '*',
//    /*expected_has_source*/true, location.origin, kRemoteOrigin);
//}, 'Fail to send and receive messages using a sandboxed iframe.');

//promise_test(async t => {
//  const iframe = await add_iframe(
//    t, { src: kDocumentMessageTarget, sandbox: 'allow-scripts' });
//  await do_message_port_error_test(t, iframe.contentWindow, '*');
//}, 'Fail to send and receive messages using a message port in a sandboxed ' +
//  'iframe.');

//promise_test(async t => {
//  const iframe_data_uri = await create_message_target_data_uri(t);
//  const iframe = await add_iframe(t, { src: iframe_data_uri });
//  await do_message_error_test(t, self, iframe.contentWindow, '*',
//    /*expected_has_source*/true, location.origin, location.origin);
//}, 'Fail to send and receive messages using a data URI iframe.');

//promise_test(async t => {
//  const iframe_data_uri = await create_message_target_data_uri(t);
//  const iframe = await add_iframe(t, { src: iframe_data_uri });
//  await do_message_port_error_test(t, iframe.contentWindow, '*');
//}, 'Fail to send and receive messages using a message port in a data URI iframe.');

promise_test(async t => {
  const child_window = await open_window(t, kRemoteOriginDocumentMessageTarget);
  await do_message_error_test(
    t, self, child_window, '*', true, location.origin, kRemoteOrigin);
}, 'Fail to send and receive messages using a cross origin window.');

promise_test(async t => {
  const child_window = await open_window(t, kRemoteOriginDocumentMessageTarget);
  await do_message_port_error_test(t, child_window, '*');
}, 'Fail to send and receive messages using a cross origin message port in ' +
  'a window.');

//promise_test(async t => {
//  const url = `${kDocumentMessageTarget}?pipe=header(Content-Security-Policy` +
//    ', sandbox allow-scripts)';
//  const child_window = await open_window(t, url);
//  await do_message_error_test(
//    t, self, child_window, '*',
//    /*expected_has_source*/true, location.origin, location.origin);
//}, 'Fail to send and receive messages using a sandboxed window.');

//promise_test(async t => {
//  const url = `${kDocumentMessageTarget}?pipe=header(Content-Security-Policy` +
//    ', sandbox allow-scripts)';
//  const child_window = await open_window(t, url);
//  await do_message_port_error_test(t, child_window, '*');
//}, 'Fail to send and receive messages using a message port in a sandboxed ' +
//  'window.');

promise_test(async t => {
  const broadcast_channel_name = 'file-system-file-handle-channel';
  const broadcast_channel = new BroadcastChannel(broadcast_channel_name);
  const broadcast_channel_event_watcher =
    new EventWatcher(t, broadcast_channel, 'message');

  const iframe = await add_iframe(t, { src: kDocumentMessageTarget });
  await create_broadcast_channel(
    t, broadcast_channel_name, self, iframe.contentWindow, '*');

  const scope = `${kServiceWorkerMessageTarget}` +
    '?post-message-to-broadcast-channel-with-file-handle';

  const registration = await service_worker_unregister_and_register(
    t, kServiceWorkerMessageTarget, scope);

  await create_broadcast_channel(
    t, broadcast_channel_name,
    navigator.serviceWorker, registration.installing);

  const dedicated_worker =
    create_dedicated_worker(t, kDedicatedWorkerMessageTarget);

  await create_broadcast_channel(
    t, broadcast_channel_name, dedicated_worker, dedicated_worker);

  const file_system_handles =
    await create_and_send_file_system_handles(t, broadcast_channel);

  const first_message_event =
    await broadcast_channel_event_watcher.wait_for('message');

  const second_message_event =
    await broadcast_channel_event_watcher.wait_for('message');

  const third_message_event =
    await broadcast_channel_event_watcher.wait_for('message');

  await verify_response_with_file_system_handles(
    first_message_event.data, file_system_handles);

  await verify_response_with_file_system_handles(
    second_message_event.data, file_system_handles);

  await verify_response_with_file_system_handles(
    third_message_event.data, file_system_handles);
}, 'Send and receive messages using a broadcast channel in an iframe, ' +
  'dedicated worker and service worker.');