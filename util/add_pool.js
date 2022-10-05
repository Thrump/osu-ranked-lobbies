// Intended to run manually. Not for automation.

async function add_pool(pool_url) {
  const collection_id = parseInt(pool_url.split('collections/')[1], 10);

  const res = await fetch(`https://osucollector.com/api/collections/${collection_id}`);
  if (res.status == 404) {
    throw new Error('Collection not found.');
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }

  const json = await res.json();
  // json.uploader.id


  // "beatmapsets": [
  //   {
  //       "id": 1118444,
  //       "beatmaps": [
  //           {
  //               "checksum": "84f9217b05c6341c03aa867e59188583",
  //               "id": 2336104
  //           }

  lobby.data.collection_id = collection_id;
  await lobby.select_next_map();
}
