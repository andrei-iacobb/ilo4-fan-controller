import type { NextApiRequest, NextApiResponse } from "next";

import { setFanSpeeds } from "../../lib/iloClient";
import {
    changeFanSpeedSchema,
    type ChangeFanSpeedInput,
} from "../../schemas/changeFanSpeed";

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
        res.setHeader("Allow", ["POST"]);
        return res.status(405).json({ message: "Method Not Allowed" });
    }

    try {
        const body: ChangeFanSpeedInput = await changeFanSpeedSchema.validate(
            req.body,
            { abortEarly: false, stripUnknown: true }
        );
        await setFanSpeeds(body);
        return res.status(200).json({ message: "ok" });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to update fans";
        return res.status(400).json({ message });
    }
};

export default handler;
